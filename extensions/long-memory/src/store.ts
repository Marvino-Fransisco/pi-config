import pg from "pg";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { readConfig } from "./config.ts";

const MODEL = "gemini-embedding-001";
const DIMENSIONS = 768;

export type Scope = "global" | "project" | "both";

export type MemoryRow = {
  id: string;
  project_id: string | null;
  kind: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
  similarity?: number;
  indexed?: boolean;
};

function projectPath(cwd: string): string {
  try {
    return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return realpathSync(cwd);
  }
}

async function database<T>(reader: boolean, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const variable = reader ? "MEMORY_READER_DATABASE_URL" : "MEMORY_DATABASE_URL";
  const config = readConfig();
  const connectionString = reader ? config.readerUrl : config.ownerUrl;
  if (!connectionString) throw new Error(`${variable} or its corresponding database password is not configured`);
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  await client.connect();
  try {
    if (reader) {
      const result = await client.query("SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      const role = result.rows[0];
      if (!role || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls || role.name !== "memory_reader") throw new Error("MEMORY_READER_DATABASE_URL must use the restricted memory_reader role");
    }
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function embed(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[]> {
  const key = readConfig().googleKey;
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  if (!text.trim() || text.length > 8000) throw new Error("Embedding text must be between 1 and 8000 characters");
  const headers = { "content-type": "application/json", "x-goog-api-key": key };
  const content = { parts: [{ text }] };
  const count = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:countTokens`, {
    method: "POST", headers, body: JSON.stringify({ contents: [content] }), signal: AbortSignal.timeout(15000),
  });
  if (!count.ok) throw new Error(`Google token count failed (HTTP ${count.status})`);
  const tokenData = await count.json() as { totalTokens?: unknown };
  if (!Number.isSafeInteger(tokenData.totalTokens) || (tokenData.totalTokens as number) < 1) throw new Error("Google returned an invalid token count");
  if ((tokenData.totalTokens as number) > 2048) throw new Error("Embedding text exceeds the 2048-token model limit");
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

function scopeFilter(scope: Scope): string {
  if (scope === "global") return "m.project_id IS NULL";
  if (scope === "project") return "p.path = $1";
  return "(m.project_id IS NULL OR p.path = $1)";
}

export async function listProjects(): Promise<Array<{ id: string; path: string; name: string }>> {
  return database(false, async (client) => (await client.query("SELECT id, path, name FROM projects ORDER BY name, path LIMIT 100")).rows);
}

export async function listMemories(cwd: string, scope: Scope = "both", kind?: string, offset = 0): Promise<MemoryRow[]> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Offset must be a non-negative integer");
  return database(false, async (client) => {
    const path = projectPath(cwd);
    const params: unknown[] = scope === "global" ? [] : [path];
    params.push(kind ?? null, offset);
    const result = await client.query<MemoryRow>(`SELECT m.*, EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = '${MODEL}') AS indexed FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE ${scopeFilter(scope)} AND ($${params.length - 1}::text IS NULL OR m.kind = $${params.length - 1}) ORDER BY m.updated_at DESC, m.id DESC LIMIT 50 OFFSET $${params.length}`, params);
    return result.rows;
  });
}

export async function searchMemories(cwd: string, text: string, scope: Scope = "both"): Promise<MemoryRow[]> {
  const vector = await embed(text, "RETRIEVAL_QUERY");
  return database(false, async (client) => {
    const path = projectPath(cwd);
    const scopeSql = scope === "global" ? "m.project_id IS NULL" : scope === "project" ? "p.path = $2" : "(m.project_id IS NULL OR p.path = $2)";
    const result = await client.query<MemoryRow>(`SELECT m.*, 1 - (e.embedding <=> $1::vector) AS similarity FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id LEFT JOIN projects p ON p.id = m.project_id WHERE e.model = $${scope === "global" ? 2 : 3} AND ${scopeSql} ORDER BY e.embedding <=> $1::vector LIMIT 5`, scope === "global" ? [`[${vector.join(",")}]`, MODEL] : [`[${vector.join(",")}]`, path, MODEL]);
    return result.rows;
  });
}

export async function getMemory(cwd: string, id: string): Promise<MemoryRow | undefined> {
  if (!/^\d+$/.test(id)) throw new Error("Memory id must be a positive integer");
  return database(false, async (client) => (await client.query<MemoryRow>(`SELECT m.*, EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = '${MODEL}') AS indexed FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = $1 AND (m.project_id IS NULL OR p.path = $2)`, [id, projectPath(cwd)])).rows[0]);
}

async function indexMemory(client: pg.Client, id: string, content: string): Promise<string | undefined> {
  try {
    const vector = await embed(content, "RETRIEVAL_DOCUMENT");
    await client.query("BEGIN");
    try {
      const current = await client.query("SELECT id FROM memories WHERE id = $1 AND content = $2 FOR UPDATE", [id, content]);
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return "Memory changed before embedding completed; it was not indexed.";
      }
      await client.query("INSERT INTO memory_embeddings (memory_id, model, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT (memory_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, created_at = now()", [id, MODEL, `[${vector.join(",")}]`]);
      await client.query("COMMIT");
      return undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    return `Memory saved but semantic indexing failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function saveMemory(cwd: string, scope: "global" | "project", kind: string, content: string): Promise<{ id: string; warning?: string; duplicate?: boolean }> {
  content = content.trim();
  if (!content.trim() || content.length > 8000) throw new Error("Memory content must be between 1 and 8000 characters");
  if (!kind.trim() || kind.length > 80) throw new Error("Memory kind must be between 1 and 80 characters");
  return database(false, async (client) => {
    let projectId: string | null = null;
    if (scope === "project") {
      const path = projectPath(cwd);
      const project = await client.query("INSERT INTO projects(path, name) VALUES ($1, $2) ON CONFLICT(path) DO UPDATE SET name = EXCLUDED.name RETURNING id", [path, basename(path)]);
      projectId = project.rows[0].id;
    }
    await client.query("BEGIN");
    let id: string;
    let duplicate = false;
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${projectId ?? "global"}:${content}`]);
      const existing = await client.query("SELECT id FROM memories WHERE project_id IS NOT DISTINCT FROM $1::bigint AND btrim(content) = $2 ORDER BY id LIMIT 1", [projectId, content]);
      if (existing.rows.length) { id = existing.rows[0].id; duplicate = true; }
      else {
        const result = await client.query("INSERT INTO memories(project_id, kind, content, source) VALUES($1, $2, $3, $4) RETURNING id", [projectId, kind, content, "user request"]);
        id = result.rows[0].id;
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    const warning = await indexMemory(client, id, content);
    return { id, warning, duplicate };
  });
}

export async function updateMemory(cwd: string, id: string, content: string): Promise<{ warning?: string }> {
  content = content.trim();
  if (!/^\d+$/.test(id)) throw new Error("Memory id must be a positive integer");
  if (!content.trim() || content.length > 8000) throw new Error("Memory content must be between 1 and 8000 characters");
  return database(false, async (client) => {
    await client.query("BEGIN");
    try {
      const current = await client.query<MemoryRow>("SELECT m.* FROM memories m WHERE m.id = $1 AND (m.project_id IS NULL OR m.project_id IN (SELECT id FROM projects WHERE path = $2)) FOR UPDATE", [id, projectPath(cwd)]);
      const memory = current.rows[0];
      if (!memory) throw new Error("Memory not found in global or current project scope");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${memory.project_id ?? "global"}:${content}`]);
      const duplicate = await client.query("SELECT id FROM memories WHERE project_id IS NOT DISTINCT FROM $1::bigint AND btrim(content) = $2 AND id <> $3 LIMIT 1", [memory.project_id, content, id]);
      if (duplicate.rows.length) throw new Error(`Duplicate of memory #${duplicate.rows[0].id}; update cancelled`);
      if (memory.content !== content) {
        await client.query("INSERT INTO memory_revisions(memory_id, content, source) VALUES ($1, $2, $3)", [id, memory.content, memory.source]);
        await client.query("UPDATE memories SET content = $2, updated_at = now() WHERE id = $1", [id, content]);
      }
      await client.query("DELETE FROM memory_embeddings WHERE memory_id = $1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return { warning: await indexMemory(client, id, content) };
  });
}

export async function deleteMemory(cwd: string, id: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new Error("Memory id must be a positive integer");
  return database(false, async (client) => {
    const result = await client.query("DELETE FROM memories m WHERE m.id = $1 AND (m.project_id IS NULL OR m.project_id IN (SELECT id FROM projects WHERE path = $2))", [id, projectPath(cwd)]);
    if (!result.rowCount) throw new Error("Memory not found in global or current project scope");
  });
}

export async function memoryStats(cwd: string, scope: Scope = "both") {
  return database(false, async (client) => {
    const params = scope === "global" ? [] : [projectPath(cwd)];
    const result = await client.query<{ scope: string; kind: string; total: string; indexed: string }>(`SELECT CASE WHEN m.project_id IS NULL THEN 'global' ELSE 'project' END AS scope, m.kind, count(*) AS total, count(e.memory_id) AS indexed FROM memories m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = '${MODEL}' WHERE ${scopeFilter(scope)} GROUP BY 1, 2 ORDER BY 1, 2`, params);
    return { scope, model: MODEL, dimensions: DIMENSIONS, total: result.rows.reduce((sum, row) => sum + Number(row.total), 0), indexed: result.rows.reduce((sum, row) => sum + Number(row.indexed), 0), groups: result.rows };
  });
}

export async function debugRetrieval(cwd: string, query: string, scope: Scope = "both") {
  const started = performance.now();
  const rows = await searchMemories(cwd, query, scope);
  const stats = await memoryStats(cwd, scope);
  return { query, project: scope === "global" ? null : projectPath(cwd), ...stats, strategy: "Exact cosine distance; top 5 indexed memories; no minimum similarity threshold. Unindexed memories are excluded. No automatic prompt injection.", elapsedMs: Math.round(performance.now() - started), rows };
}

export async function memoryHistory(cwd: string, id: string) {
  if (!(await getMemory(cwd, id))) throw new Error("Memory not found in global or current project scope");
  return database(false, async (client) => (await client.query<{ id: string; content: string; source: string; replaced_at: string }>("SELECT r.id, r.content, r.source, r.replaced_at FROM memory_revisions r JOIN memories m ON m.id = r.memory_id LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = $1 AND (m.project_id IS NULL OR p.path = $2) ORDER BY r.id DESC LIMIT 50", [id, projectPath(cwd)])).rows);
}

export async function queryMemory(sql: string): Promise<unknown[]> {
  if (!sql.trim() || sql.length > 10000) throw new Error("SQL must be between 1 and 10000 characters");
  return database(true, async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query({ text: `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS memory_query LIMIT 101`, rowMode: "array" });
      if (Array.isArray(result)) throw new Error("Only one SQL statement is allowed");
      if (result.command !== "SELECT") throw new Error("Only SELECT queries are allowed");
      const rows = result.rows.slice(0, 100);
      return [{ columns: result.fields.map((field) => field.name), rows, truncated: result.rows.length > 100 }];
    } finally {
      await client.query("ROLLBACK");
    }
  });
}
