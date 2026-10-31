import pg from "pg";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { readConfig } from "./config.ts";

export const MODEL = "gemini-embedding-001";
export const DIMENSIONS = 768;
export const TRASH_DAYS = 30;
const PAGE = 50;
const TOP_K = 5;
const COUNT_TOKENS_ABOVE = 512;
const INDEXED = `EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = '${MODEL}') AS indexed`;
const REVISIONS = "(SELECT count(*) FROM memory_revisions r WHERE r.memory_id = m.id)::int AS revisions";
const ROLE_CHECK = "SELECT current_user AS name, (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS unsafe FROM pg_roles WHERE rolname = current_user";

export type Scope = "global" | "project" | "both";

export type MemoryRow = {
  id: string;
  project_id: string | null;
  kind: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  similarity?: number;
  indexed?: boolean;
  revisions?: number;
  belowThreshold?: boolean;
};

export type ProjectRow = { id: string; path: string; name: string; memories: number; exists: boolean };

const execFileAsync = promisify(execFile);
const projectPaths = new Map<string, Promise<string>>();
const pools = new Map<string, pg.Pool>();
const verified = new WeakSet<pg.PoolClient>();

export function projectPath(cwd: string): Promise<string> {
  let cached = projectPaths.get(cwd);
  if (!cached) {
    cached = execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" })
      .then((result) => realpath(result.stdout.trim()), () => realpath(cwd));
    cached.catch(() => projectPaths.delete(cwd));
    projectPaths.set(cwd, cached);
  }
  return cached;
}

export function normalizeKind(kind: string): string {
  const value = kind.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value)) throw new Error("Memory kind must be 1-80 characters: letters, digits, '.', '_' or '-'");
  return value;
}

function validId(id: string, name = "Memory id"): void {
  if (!/^\d+$/.test(id)) throw new Error(`${name} must be a positive integer`);
}

function validContent(content: string): string {
  const value = content.trim();
  if (!value || value.length > 8000) throw new Error("Memory content must be between 1 and 8000 characters");
  return value;
}

async function verifyRole(client: pg.ClientBase, message: string, expected?: string): Promise<void> {
  const role = (await client.query<{ name: string; unsafe: boolean }>(ROLE_CHECK)).rows[0];
  if (!role || role.unsafe || (expected !== undefined && role.name !== expected)) throw new Error(message);
}

async function database<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const connectionString = readConfig().appUrl;
  if (!connectionString) throw new Error("MEMORY_APP_PASSWORD (or MEMORY_DATABASE_URL) is not configured; see the long-memory README migration");
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({ connectionString, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 10000, allowExitOnIdle: true });
    pool.on("error", () => pools.delete(connectionString));
    pools.set(connectionString, pool);
  }
  const client = await pool.connect();
  let failed = false;
  try {
    if (!verified.has(client)) {
      await verifyRole(client, "MEMORY_DATABASE_URL must use a restricted application role (memory_app), not a superuser or role administrator");
      verified.add(client);
    }
    return await fn(client);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    client.release(failed);
  }
}

async function transaction<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function closePools(): Promise<void> {
  const current = [...pools.values()];
  pools.clear();
  await Promise.all(current.map((pool) => pool.end()));
}

function scopeWhere(scope: Scope, path: string, params: unknown[]): string {
  if (scope === "global") return "m.project_id IS NULL";
  params.push(path);
  const project = `p.path = $${params.length}`;
  return scope === "project" ? project : `(m.project_id IS NULL OR ${project})`;
}

export async function embed(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[]> {
  const key = readConfig().googleKey;
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  if (!text.trim() || text.length > 8000) throw new Error("Embedding text must be between 1 and 8000 characters");
  const headers = { "content-type": "application/json", "x-goog-api-key": key };
  const content = { parts: [{ text }] };
  if (text.length > COUNT_TOKENS_ABOVE) {
    const count = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:countTokens`, {
      method: "POST", headers, body: JSON.stringify({ contents: [content] }), signal: AbortSignal.timeout(15000),
    });
    if (!count.ok) throw new Error(`Google token count failed (HTTP ${count.status})`);
    const tokenData = await count.json() as { totalTokens?: unknown };
    if (!Number.isSafeInteger(tokenData.totalTokens) || (tokenData.totalTokens as number) < 1) throw new Error("Google returned an invalid token count");
    if ((tokenData.totalTokens as number) > 2048) throw new Error("Embedding text exceeds the 2048-token model limit");
  }
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`, {
    method: "POST", headers,
    body: JSON.stringify({ content, taskType, outputDimensionality: DIMENSIONS }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Google embedding request failed (HTTP ${response.status})`);
  const data = await response.json() as { embedding?: { values?: unknown } };
  const vector = data.embedding?.values;
  if (!Array.isArray(vector) || vector.length !== DIMENSIONS || !vector.every((value) => typeof value === "number" && Number.isFinite(value)) || vector.every((value) => value === 0)) throw new Error("Google returned an invalid embedding");
  return vector;
}

export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await database(async (client) => (await client.query<Omit<ProjectRow, "exists">>("SELECT p.id, p.path, p.name, count(m.id) FILTER (WHERE m.deleted_at IS NULL)::int AS memories FROM projects p LEFT JOIN memories m ON m.project_id = p.id GROUP BY p.id ORDER BY p.name, p.path LIMIT 100")).rows);
  return rows.map((row) => ({ ...row, exists: existsSync(row.path) }));
}

async function list(cwd: string, scope: Scope, kind: string | undefined, offset: number, trash: boolean): Promise<MemoryRow[]> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Offset must be a non-negative integer");
  const path = await projectPath(cwd);
  return database(async (client) => {
    const params: unknown[] = [];
    const filter = scopeWhere(scope, path, params);
    params.push(kind ? normalizeKind(kind) : null);
    const kindParam = params.length;
    params.push(offset);
    const order = trash ? "m.deleted_at" : "m.updated_at";
    const result = await client.query<MemoryRow>(`SELECT m.*, ${INDEXED} FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE ${filter} AND m.deleted_at IS ${trash ? "NOT NULL" : "NULL"} AND ($${kindParam}::text IS NULL OR lower(m.kind) = $${kindParam}) ORDER BY ${order} DESC, m.id DESC LIMIT ${PAGE} OFFSET $${params.length}`, params);
    return result.rows;
  });
}

export function listMemories(cwd: string, scope: Scope = "both", kind?: string, offset = 0): Promise<MemoryRow[]> {
  return list(cwd, scope, kind, offset, false);
}

export function listTrash(cwd: string, scope: Scope = "both", offset = 0): Promise<MemoryRow[]> {
  return list(cwd, scope, undefined, offset, true);
}

async function ranked(cwd: string, text: string, scope: Scope): Promise<MemoryRow[]> {
  const vector = await embed(text, "RETRIEVAL_QUERY");
  const path = await projectPath(cwd);
  const minSimilarity = readConfig().minSimilarity;
  return database(async (client) => {
    const params: unknown[] = [`[${vector.join(",")}]`, MODEL];
    const filter = scopeWhere(scope, path, params);
    const result = await client.query<MemoryRow>(`SELECT m.*, 1 - (e.embedding <=> $1::vector) AS similarity FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id LEFT JOIN projects p ON p.id = m.project_id WHERE e.model = $2 AND m.deleted_at IS NULL AND ${filter} ORDER BY e.embedding <=> $1::vector LIMIT ${TOP_K}`, params);
    return result.rows.map((row) => ({ ...row, similarity: Number(row.similarity), belowThreshold: Number(row.similarity) < minSimilarity }));
  });
}

export async function searchMemories(cwd: string, text: string, scope: Scope = "both"): Promise<MemoryRow[]> {
  return (await ranked(cwd, text, scope)).filter((row) => !row.belowThreshold);
}

export async function getMemory(cwd: string, id: string, trash = false): Promise<MemoryRow | undefined> {
  validId(id);
  const path = await projectPath(cwd);
  return database(async (client) => (await client.query<MemoryRow>(`SELECT m.*, ${INDEXED}, ${REVISIONS} FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = $1 AND m.deleted_at IS ${trash ? "NOT NULL" : "NULL"} AND (m.project_id IS NULL OR p.path = $2)`, [id, path])).rows[0]);
}

async function indexMemory(client: pg.PoolClient, id: string, content: string): Promise<string | undefined> {
  try {
    const vector = await embed(content, "RETRIEVAL_DOCUMENT");
    const stored = await transaction(client, async () => {
      const current = await client.query("SELECT id FROM memories WHERE id = $1 AND content = $2 AND deleted_at IS NULL FOR UPDATE", [id, content]);
      if (!current.rowCount) return false;
      await client.query("INSERT INTO memory_embeddings (memory_id, model, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT (memory_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, created_at = now()", [id, MODEL, `[${vector.join(",")}]`]);
      return true;
    });
    return stored ? undefined : "Memory changed before embedding completed; it was not indexed.";
  } catch (error) {
    return `Memory saved but semantic indexing failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function lockContent(client: pg.PoolClient, projectId: string | null, content: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${projectId ?? "global"}:${content}`]);
}

async function findDuplicate(client: pg.PoolClient, projectId: string | null, content: string, exclude?: string): Promise<string | undefined> {
  const result = await client.query<{ id: string }>("SELECT id FROM memories WHERE project_id IS NOT DISTINCT FROM $1::bigint AND md5(content) = md5($2) AND content = $2 AND deleted_at IS NULL AND id IS DISTINCT FROM $3::bigint ORDER BY id LIMIT 1", [projectId, content, exclude ?? null]);
  return result.rows[0]?.id;
}

export async function saveMemory(cwd: string, scope: "global" | "project", kind: string, content: string): Promise<{ id: string; warning?: string; duplicate?: boolean }> {
  content = validContent(content);
  kind = normalizeKind(kind);
  const path = scope === "project" ? await projectPath(cwd) : undefined;
  return database(async (client) => {
    let projectId: string | null = null;
    if (path) {
      const project = await client.query<{ id: string }>("INSERT INTO projects(path, name) VALUES ($1, $2) ON CONFLICT(path) DO UPDATE SET name = EXCLUDED.name RETURNING id", [path, basename(path)]);
      projectId = project.rows[0]!.id;
    }
    const saved = await transaction(client, async () => {
      await lockContent(client, projectId, content);
      const existing = await findDuplicate(client, projectId, content);
      if (existing) return { id: existing, duplicate: true };
      const result = await client.query<{ id: string }>("INSERT INTO memories(project_id, kind, content, source) VALUES($1, $2, $3, $4) RETURNING id", [projectId, kind, content, "user request"]);
      return { id: result.rows[0]!.id, duplicate: false };
    });
    const warning = await indexMemory(client, saved.id, content);
    return { ...saved, warning };
  });
}

export async function updateMemory(cwd: string, id: string, content: string): Promise<{ warning?: string; changed: boolean }> {
  validId(id);
  content = validContent(content);
  const path = await projectPath(cwd);
  return database(async (client) => {
    const changed = await transaction(client, async () => {
      const memory = (await client.query<MemoryRow>("SELECT m.* FROM memories m WHERE m.id = $1 AND m.deleted_at IS NULL AND (m.project_id IS NULL OR m.project_id IN (SELECT id FROM projects WHERE path = $2)) FOR UPDATE", [id, path])).rows[0];
      if (!memory) throw new Error("Memory not found in global or current project scope");
      await lockContent(client, memory.project_id, content);
      const duplicate = await findDuplicate(client, memory.project_id, content, id);
      if (duplicate) throw new Error(`Duplicate of memory #${duplicate}; update cancelled`);
      if (memory.content === content) return false;
      await client.query("INSERT INTO memory_revisions(memory_id, content, source) VALUES ($1, $2, $3)", [id, memory.content, memory.source]);
      await client.query("UPDATE memories SET content = $2, updated_at = now() WHERE id = $1", [id, content]);
      await client.query("DELETE FROM memory_embeddings WHERE memory_id = $1", [id]);
      return true;
    });
    return { changed, warning: await indexMemory(client, id, content) };
  });
}

export async function getRevision(cwd: string, id: string, revisionId: string): Promise<{ id: string; content: string; replaced_at: string }> {
  validId(revisionId, "Revision id");
  if (!(await getMemory(cwd, id))) throw new Error("Memory not found in global or current project scope");
  const revision = await database(async (client) => (await client.query<{ id: string; content: string; replaced_at: string }>("SELECT id, content, replaced_at FROM memory_revisions WHERE id = $1 AND memory_id = $2", [revisionId, id])).rows[0]);
  if (!revision) throw new Error(`Revision #${revisionId} does not belong to memory #${id}`);
  return revision;
}

export async function restoreRevision(cwd: string, id: string, revisionId: string): Promise<{ warning?: string; changed: boolean }> {
  const revision = await getRevision(cwd, id, revisionId);
  return updateMemory(cwd, id, revision.content);
}

export async function deleteMemory(cwd: string, id: string): Promise<void> {
  validId(id);
  const path = await projectPath(cwd);
  return database(async (client) => {
    const result = await client.query("UPDATE memories m SET deleted_at = now() WHERE m.id = $1 AND m.deleted_at IS NULL AND (m.project_id IS NULL OR m.project_id IN (SELECT id FROM projects WHERE path = $2))", [id, path]);
    if (!result.rowCount) throw new Error("Memory not found in global or current project scope");
    await client.query("DELETE FROM memories WHERE deleted_at < now() - make_interval(days => $1)", [TRASH_DAYS]);
  });
}

export async function undeleteMemory(cwd: string, id: string): Promise<{ warning?: string }> {
  validId(id);
  const path = await projectPath(cwd);
  return database(async (client) => {
    const memory = await transaction(client, async () => {
      const row = (await client.query<MemoryRow>("SELECT m.* FROM memories m WHERE m.id = $1 AND m.deleted_at IS NOT NULL AND (m.project_id IS NULL OR m.project_id IN (SELECT id FROM projects WHERE path = $2)) FOR UPDATE", [id, path])).rows[0];
      if (!row) throw new Error("Memory not found in trash for global or current project scope");
      await lockContent(client, row.project_id, row.content);
      const duplicate = await findDuplicate(client, row.project_id, row.content, id);
      if (duplicate) throw new Error(`Active memory #${duplicate} already has this content; restore cancelled`);
      await client.query("UPDATE memories SET deleted_at = NULL WHERE id = $1", [id]);
      return row;
    });
    const indexed = (await client.query("SELECT 1 FROM memory_embeddings WHERE memory_id = $1 AND model = $2", [id, MODEL])).rowCount;
    return { warning: indexed ? undefined : await indexMemory(client, id, memory.content) };
  });
}

export async function purgeMemory(cwd: string, id: string): Promise<void> {
  validId(id);
  const path = await projectPath(cwd);
  return database(async (client) => {
    const result = await client.query("DELETE FROM memories m WHERE m.id = $1 AND m.deleted_at IS NOT NULL AND (m.project_id IS NULL OR m.project_id IN (SELECT id FROM projects WHERE path = $2))", [id, path]);
    if (!result.rowCount) throw new Error("Memory not found in trash for global or current project scope");
  });
}

export async function relinkProject(cwd: string, oldPath: string): Promise<{ from: string; to: string; moved: number }> {
  const resolved = resolve(oldPath.trim());
  const from = await realpath(resolved).catch(() => resolved);
  const to = await projectPath(cwd);
  if (from === to) throw new Error("The old path is the current project");
  return database((client) => transaction(client, async () => {
    const old = (await client.query<{ id: string }>("SELECT id FROM projects WHERE path = $1 FOR UPDATE", [from])).rows[0];
    if (!old) throw new Error(`No registered project at ${from}`);
    const current = (await client.query<{ id: string }>("SELECT id FROM projects WHERE path = $1 FOR UPDATE", [to])).rows[0];
    if (!current) {
      await client.query("UPDATE projects SET path = $2, name = $3 WHERE id = $1", [old.id, to, basename(to)]);
      const count = await client.query<{ total: number }>("SELECT count(*)::int AS total FROM memories WHERE project_id = $1", [old.id]);
      return { from, to, moved: count.rows[0]!.total };
    }
    const moved = await client.query("UPDATE memories SET project_id = $2 WHERE project_id = $1", [old.id, current.id]);
    await client.query("DELETE FROM projects WHERE id = $1", [old.id]);
    return { from, to, moved: moved.rowCount ?? 0 };
  }));
}

export async function reindexMemories(cwd: string, scope: Scope = "both"): Promise<{ attempted: number; indexed: number; warnings: string[] }> {
  const path = await projectPath(cwd);
  return database(async (client) => {
    const params: unknown[] = [];
    const filter = scopeWhere(scope, path, params);
    const pending = (await client.query<MemoryRow>(`SELECT m.id, m.content FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE ${filter} AND m.deleted_at IS NULL AND NOT ${INDEXED.replace(" AS indexed", "")} ORDER BY m.id LIMIT ${PAGE}`, params)).rows;
    const warnings: string[] = [];
    for (const row of pending) {
      const warning = await indexMemory(client, row.id, row.content);
      if (warning) warnings.push(`#${row.id}: ${warning}`);
    }
    return { attempted: pending.length, indexed: pending.length - warnings.length, warnings };
  });
}

export async function memoryStats(cwd: string, scope: Scope = "both") {
  const path = await projectPath(cwd);
  const minSimilarity = readConfig().minSimilarity;
  return database(async (client) => {
    const params: unknown[] = [];
    const filter = scopeWhere(scope, path, params);
    const result = await client.query<{ scope: "global" | "project"; kind: string; total: number; indexed: number }>(`SELECT CASE WHEN m.project_id IS NULL THEN 'global' ELSE 'project' END AS scope, lower(m.kind) AS kind, count(*)::int AS total, count(e.memory_id)::int AS indexed FROM memories m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = '${MODEL}' WHERE ${filter} AND m.deleted_at IS NULL GROUP BY 1, 2 ORDER BY 3 DESC, 2`, params);
    const trash = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE ${filter} AND m.deleted_at IS NOT NULL`, params);
    const sum = (rows: typeof result.rows, key: "total" | "indexed") => rows.reduce((total, row) => total + row[key], 0);
    return {
      scope, model: MODEL, dimensions: DIMENSIONS, topK: TOP_K, minSimilarity,
      total: sum(result.rows, "total"), indexed: sum(result.rows, "indexed"), trash: trash.rows[0]!.total,
      global: sum(result.rows.filter((row) => row.scope === "global"), "total"),
      project: sum(result.rows.filter((row) => row.scope === "project"), "total"),
      groups: result.rows,
    };
  });
}

export type MemoryStats = Awaited<ReturnType<typeof memoryStats>>;

export async function debugRetrieval(cwd: string, query: string, scope: Scope = "both") {
  const started = performance.now();
  const rows = await ranked(cwd, query, scope);
  const elapsedMs = Math.round(performance.now() - started);
  const stats = await memoryStats(cwd, scope);
  return {
    query, projectPath: scope === "global" ? null : await projectPath(cwd), ...stats, elapsedMs, rows,
    passed: rows.filter((row) => !row.belowThreshold).length,
    strategy: `Exact cosine distance; top ${TOP_K} indexed memories; minimum similarity ${Math.round(stats.minSimilarity * 100)}%. Unindexed and trashed memories are excluded. No automatic prompt injection.`,
  };
}

export async function memoryHistory(cwd: string, id: string) {
  if (!(await getMemory(cwd, id))) throw new Error("Memory not found in global or current project scope");
  return database(async (client) => (await client.query<{ id: string; content: string; source: string; replaced_at: string }>("SELECT id, content, source, replaced_at FROM memory_revisions WHERE memory_id = $1 ORDER BY id DESC LIMIT 50", [id])).rows);
}

export async function queryMemory(sql: string): Promise<Array<{ columns: string[]; rows: unknown[][]; truncated: boolean }>> {
  if (!sql.trim() || sql.length > 10000) throw new Error("SQL must be between 1 and 10000 characters");
  const connectionString = readConfig().readerUrl;
  if (!connectionString) throw new Error("MEMORY_READER_DATABASE_URL or its corresponding database password is not configured");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 3000, query_timeout: 8000 });
  await client.connect();
  try {
    await verifyRole(client, "MEMORY_READER_DATABASE_URL must use the restricted memory_reader role", "memory_reader");
    await client.query("BEGIN READ ONLY");
    try {
      const config: pg.QueryArrayConfig & { queryMode: "extended" } = { text: `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS memory_query LIMIT 101`, rowMode: "array", queryMode: "extended" };
      const result = await client.query(config);
      if (result.command !== "SELECT") throw new Error("Only SELECT queries are allowed");
      return [{ columns: result.fields.map((field) => field.name), rows: result.rows.slice(0, 100), truncated: result.rows.length > 100 }];
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}
