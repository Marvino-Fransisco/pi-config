import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import extension from "../extensions/long-memory/index.ts";
import { embed, saveMemory, updateMemory, deleteMemory, listMemories, searchMemories, queryMemory } from "../extensions/long-memory/src/store.ts";
import { searchPanel } from "../extensions/long-memory/ui/panel.ts";
import { readConfig } from "../extensions/long-memory/src/config.ts";

const ownerUrl = process.env.LONG_MEMORY_TEST_DATABASE_URL;
const readerUrl = process.env.LONG_MEMORY_TEST_READER_URL;

test("configuration reads a private env file without changing process environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-config-"));
  const path = join(dir, ".env");
  try {
    writeFileSync(path, "MEMORY_DB_PASSWORD='pass@word'\nMEMORY_READER_PASSWORD=reader\nMEMORY_DB_PORT=55434\nGEMINI_API_KEY=file-key\nUNRELATED_TEST_VALUE=ignored\n");
    const config = readConfig(path, {});
    assert.equal(config.ownerUrl, "postgresql://memory_owner:pass%40word@127.0.0.1:55434/pi_memory");
    assert.equal(config.readerUrl, "postgresql://memory_reader:reader@127.0.0.1:55434/pi_memory");
    assert.equal(config.googleKey, "file-key");
    assert.equal(process.env.UNRELATED_TEST_VALUE, undefined);
    const override = readConfig(path, { MEMORY_DATABASE_URL: "postgresql://override/db", GEMINI_API_KEY: "env-key" });
    assert.equal(override.ownerUrl, "postgresql://override/db");
    assert.equal(override.googleKey, "env-key");
    assert.deepEqual(readConfig(join(dir, "missing"), {}), { ownerUrl: undefined, readerUrl: undefined, googleKey: undefined });
    assert.throws(() => readConfig(dir, {}));
    assert.throws(() => readConfig(path, { MEMORY_DB_PORT: "70000" }), /valid TCP port/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("default configuration path remains at the extension root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-layout-"));
  try {
    mkdirSync(join(dir, "src"));
    copyFileSync(new URL("../extensions/long-memory/src/config.ts", import.meta.url), join(dir, "src/config.ts"));
    writeFileSync(join(dir, ".env"), "MEMORY_DB_PASSWORD=owner\nMEMORY_DB_PORT=55434\nGEMINI_API_KEY=test-key\n");
    const module = await import(pathToFileURL(join(dir, "src/config.ts")).href);
    const config = module.readConfig(undefined, {});
    assert.equal(config.googleKey, "test-key");
    assert.equal(config.ownerUrl, "postgresql://memory_owner:owner@127.0.0.1:55434/pi_memory");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("embedding requests use Google retrieval configuration and validate output", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  let body: any;
  globalThis.fetch = (async (url, options) => {
    if (String(url).endsWith(":countTokens")) return new Response(JSON.stringify({ totalTokens: 3 }), { status: 200 });
    body = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ embedding: { values: Array.from({ length: 768 }, () => 1) } }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal((await embed("hello", "RETRIEVAL_QUERY")).length, 768);
    assert.equal(body.taskType, "RETRIEVAL_QUERY");
    assert.equal(body.outputDimensionality, 768);
    globalThis.fetch = (async (url) => new Response(JSON.stringify(String(url).endsWith(":countTokens") ? { totalTokens: 3 } : { embedding: { values: [1] } }), { status: 200 })) as typeof fetch;
    await assert.rejects(embed("hello", "RETRIEVAL_DOCUMENT"), /invalid embedding/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ totalTokens: 2049 }), { status: 200 })) as typeof fetch;
    await assert.rejects(embed("hello", "RETRIEVAL_DOCUMENT"), /2048-token/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  }
});

test("agent mutations require explicit interactive confirmation", async () => {
  let tool: any;
  extension({ registerTool: (value: unknown) => { tool = value; }, registerCommand() {} } as never);
  await assert.rejects(tool.execute("id", { action: "save", scope: "global", content: "remember" }, undefined, undefined, { hasUI: false }), /confirmation/);
  let asked = false;
  const ctx = { hasUI: true, ui: { confirm: async () => { asked = true; return false; } } };
  await assert.rejects(tool.execute("id", { action: "save", scope: "global", content: "remember" }, undefined, undefined, ctx), /cancelled/);
  assert.equal(asked, true);
});

test("PostgreSQL memory scopes, semantic index and read-only query", { skip: !ownerUrl || !readerUrl }, async () => {
  const ownerAddress = new URL(ownerUrl!);
  const readerAddress = new URL(readerUrl!);
  assert.match(ownerAddress.pathname, /^\/pi_memory_test(?:_\w+)?$/);
  assert.equal(ownerAddress.host, readerAddress.host);
  assert.equal(ownerAddress.pathname, readerAddress.pathname);
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.MEMORY_DATABASE_URL = ownerUrl;
  process.env.MEMORY_READER_DATABASE_URL = readerUrl;
  process.env.GEMINI_API_KEY = "test-key";
  const a = mkdtempSync(join(tmpdir(), "memory-a-"));
  const b = mkdtempSync(join(tmpdir(), "memory-b-"));
  globalThis.fetch = (async (url) => new Response(JSON.stringify(String(url).endsWith(":countTokens") ? { totalTokens: 3 } : { embedding: { values: Array.from({ length: 768 }, () => 1) } }), { status: 200 })) as typeof fetch;
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query("TRUNCATE memory_embeddings, memories, projects RESTART IDENTITY CASCADE");
    const global = await saveMemory(a, "global", "preference", "global preference");
    const projectA = await saveMemory(a, "project", "decision", "project A decision");
    await saveMemory(b, "project", "decision", "project B decision");
    assert.equal(global.warning, undefined);
    assert.deepEqual((await listMemories(a)).map((row) => row.content).sort(), ["global preference", "project A decision"]);
    assert.deepEqual((await searchMemories(a, "query")).map((row) => row.content).sort(), ["global preference", "project A decision"]);
    let closed = false;
    const context = { mode: "tui", cwd: a, ui: { custom: async (factory: any) => {
      const panel = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => { closed = true; });
      panel.handleInput("query");
      panel.handleInput("return");
      for (let i = 0; i < 50 && !panel.render(100).join("\n").includes("project A decision"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(panel.render(100).join("\n"), /project A decision/);
      panel.handleInput("down");
      panel.handleInput("return");
      assert.match(panel.render(100).join("\n"), /Source:/);
      panel.handleInput("escape");
      panel.handleInput("tab");
      assert.match(panel.render(100).join("\n"), /Memory · global/);
      panel.handleInput("escape");
    } } };
    await searchPanel(context as never);
    assert.equal(closed, true);
    await assert.rejects(deleteMemory(b, projectA.id), /not found/);
    await updateMemory(a, projectA.id, "updated decision");
    assert.ok((await searchMemories(a, "query")).some((row) => row.content === "updated decision"));
    const results = await queryMemory("SELECT count(*) FROM memories;");
    assert.equal((results[0] as any).rows[0][0], "3");
    await assert.rejects(queryMemory("DELETE FROM memories"));
    await assert.rejects(queryMemory("SELECT 1; DELETE FROM memories"));
    process.env.MEMORY_READER_DATABASE_URL = ownerUrl;
    await assert.rejects(queryMemory("SELECT 1"), /restricted memory_reader role/);
    process.env.MEMORY_READER_DATABASE_URL = readerUrl;
    await deleteMemory(a, global.id);
    assert.equal((await listMemories(a)).length, 1);
    process.env.GEMINI_API_KEY = "";
    const unindexed = await saveMemory(a, "global", "note", "saved without key");
    assert.match(unindexed.warning!, /GEMINI_API_KEY/);
    assert.ok((await listMemories(a)).some((row) => row.content === "saved without key" && row.indexed === false));
  } finally {
    await owner.query("TRUNCATE memory_embeddings, memories, projects RESTART IDENTITY CASCADE");
    await owner.end();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    delete process.env.MEMORY_DATABASE_URL;
    delete process.env.MEMORY_READER_DATABASE_URL;
  }
});
