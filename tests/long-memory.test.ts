import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import extension from "../extensions/long-memory/index.ts";
import { debugRetrieval, embed, getMemory, memoryHistory, memoryStats, saveMemory, updateMemory, deleteMemory, listMemories, searchMemories, queryMemory } from "../extensions/long-memory/src/store.ts";
import { createPanel, formatTable, searchPanel } from "../extensions/long-memory/ui/panel.ts";
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
  extension({ on() {}, registerTool: (value: unknown) => { tool = value; }, registerCommand() {} } as never);
  await assert.rejects(tool.execute("id", { action: "save", scope: "global", content: "remember" }, undefined, undefined, { hasUI: false }), /confirmation/);
  let asked = false;
  const ctx = { hasUI: true, ui: { confirm: async () => { asked = true; return false; } } };
  await assert.rejects(tool.execute("id", { action: "save", scope: "global", content: "remember" }, undefined, undefined, ctx), /cancelled/);
  assert.equal(asked, true);
  for (const action of ["update", "supersede"]) {
    await assert.rejects(tool.execute("id", { action, id: "1", content: "replacement" }, undefined, undefined, ctx), /cancelled/);
  }
});

test("memory command discovers actions and manages sticky overlay focus", async () => {
  let command: any;
  const events: Record<string, Function> = {};
  extension({ on: (name: string, handler: Function) => { events[name] = handler; }, registerTool() {}, registerCommand: (_name: string, value: unknown) => { command = value; } } as never);
  assert.deepEqual(command.getArgumentCompletions("save ").map((entry: any) => entry.value), ["save global", "save project"]);
  assert.match(command.description, /\/memory list/);
  let panel: any;
  let focused = false;
  let hidden = false;
  const handle = { focus: () => { focused = true; }, unfocus: () => { focused = false; }, isFocused: () => focused, hide: () => { hidden = true; } };
  const tui = { terminal: { columns: 120, rows: 30 }, requestRender() {}, showOverlay: (component: unknown, options: any) => { panel = component; assert.equal(options.anchor, "top-right"); assert.equal(options.nonCapturing, true); return handle; } };
  const ctx = { mode: "tui", cwd: "/tmp", ui: { setWidget: (_name: string, factory: Function) => factory(tui, { fg: (_color: string, text: string) => text }) } };
  await events.session_start({}, ctx);
  await command.handler("", ctx);
  assert.equal(focused, true);
  assert.match(panel.render(70).join("\n"), /\[STATS\].*SEARCH.*LIST.*DEBUG.*SQL/);
  assert.match(panel.render(70).join("\n"), /Scope: Global \+ current project/);
  assert.ok(panel.render(70)[0].startsWith("\x1b[38;2;90;175;255m"));
  assert.doesNotMatch(panel.render(70).join("\n"), /Search memories|sent to Google|Filter by kind/);
  assert.match(panel.render(70).join("\n"), /Enter refresh/);
  panel.handleInput("shift+tab");
  assert.match(panel.render(70).join("\n"), /\[SQL\]/);
  panel.handleInput("tab");
  assert.match(panel.render(70).join("\n"), /\[STATS\]/);
  panel.handleInput("tab");
  assert.match(panel.render(70).join("\n"), /\[SEARCH\]/);
  assert.match(panel.render(70).join("\n"), /Search memories/);
  panel.handleInput("search text should not become a filter");
  panel.handleInput("tab");
  assert.match(panel.render(70).join("\n"), /\[LIST\]/);
  assert.match(panel.render(70).join("\n"), /Filter by kind: note, decision, preference; blank = all/);
  assert.doesNotMatch(panel.render(70).join("\n"), /search text should not become a filter/);
  assert.match(panel.render(70).join("\n"), /Loading/);
  panel.handleInput("tab");
  assert.match(panel.render(70).join("\n"), /\[DEBUG\]/);
  panel.handleInput("tab");
  assert.match(panel.render(70).join("\n"), /\[SQL\]/);
  assert.match(panel.render(70).join("\n"), /All projects \(read-only SQL\)/);
  panel.handleInput("ctrl+s");
  panel.handleInput("tab");
  assert.match(panel.render(70).join("\n"), /Scope: Global \+ current project/);
  assert.match(panel.render(70).join("\n"), /Loading/);
  panel.handleInput("escape");
  assert.equal(focused, false);
  assert.equal(hidden, false);
  assert.deepEqual(panel.handleMouse({ type: "press", button: "left" }), { handled: true, focus: true });
  assert.equal(panel.handleMouse({ type: "press", button: "right" }), undefined);
  await command.handler("", ctx);
  assert.equal(focused, true);
  await events.session_shutdown();
  assert.equal(hidden, true);
});

test("SQL errors remain visible and scrollable below the controls", async () => {
  const panel = createPanel({ cwd: "/tmp" } as never, { terminal: { rows: 30 }, requestRender() {} } as never, { fg: (color: string, text: string) => color === "error" ? `<error>${text}</error>` : text } as never, () => {});
  for (let i = 0; i < 4; i++) panel.handleInput("tab");
  panel.handleInput("x".repeat(10001));
  panel.handleInput("return");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rendered = panel.render(70).join("\n");
  assert.match(rendered, /SQL query failed/);
  assert.match(rendered, /<error>SQL must be between 1 and 10000 characters<\/error>/);
  panel.dispose();
});

test("SQL results render as sanitized tables", () => {
  const table = formatTable([{ columns: ["id", "content"], rows: [[1, "hello\u001b[31m"], [2, null]], truncated: true }]);
  assert.match(table, /id\s+│ content/);
  assert.match(table, /┌─+┬─+┐/);
  assert.match(table, /└─+┴─+┘/);
  assert.match(formatTable([{ columns: ["value"], rows: [[1]], truncated: false }]), /1 row$/);
  assert.match(table, /hello\[31m/);
  assert.match(table, /NULL/);
  assert.match(table, /limited to 100 rows/);
  assert.doesNotMatch(table, /\u001b/);
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
    const duplicate = await saveMemory(a, "global", "note", " global preference ");
    assert.equal(duplicate.id, global.id);
    assert.equal(duplicate.duplicate, true);
    const concurrent = await Promise.all([saveMemory(a, "project", "note", "concurrent duplicate"), saveMemory(a, "project", "note", "concurrent duplicate")]);
    assert.equal(concurrent[0].id, concurrent[1].id);
    await deleteMemory(a, concurrent[0].id);
    assert.equal((await listMemories(a, "both", "decision")).length, 1);
    assert.equal((await listMemories(a, "both", undefined, 50)).length, 0);
    await assert.rejects(listMemories(a, "both", undefined, -1), /Offset/);
    const statsPanel = createPanel({ cwd: a } as never, { terminal: { rows: 30 }, requestRender() {} } as never, { fg: (_color: string, text: string) => text } as never, () => {});
    try {
      for (let i = 0; i < 100 && !statsPanel.render(100).join("\n").includes("2 memories"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(statsPanel.render(100).join("\n"), /2 memories · 2 indexed/);
      statsPanel.handleInput("tab");
      statsPanel.handleInput("tab");
      statsPanel.handleInput("decision");
      statsPanel.handleInput("return");
      for (let i = 0; i < 100 && !statsPanel.render(100).join("\n").includes("project A decision"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(statsPanel.render(100).join("\n"), /project A decision/);
      assert.doesNotMatch(statsPanel.render(100).join("\n"), /global preference/);
      statsPanel.handleInput("ctrl+n");
      for (let i = 0; i < 100 && statsPanel.render(100).join("\n").includes("Loading"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(statsPanel.render(100).join("\n"), /No matching memories/);
      statsPanel.handleInput("ctrl+p");
      for (let i = 0; i < 100 && !statsPanel.render(100).join("\n").includes("project A decision"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(statsPanel.render(100).join("\n"), /project A decision/);
      statsPanel.handleInput("tab");
      statsPanel.handleInput("query");
      statsPanel.handleInput("return");
      for (let i = 0; i < 100 && !statsPanel.render(100).join("\n").includes("Exact cosine"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(statsPanel.render(100).join("\n"), /Exact cosine/);
      statsPanel.handleInput("down");
      statsPanel.handleInput("return");
      assert.match(statsPanel.render(100).join("\n"), /Source:/);
      assert.match(statsPanel.render(100).join("\n"), /SAVED CONTENT/);
      statsPanel.handleInput("ctrl+d");
      assert.match(statsPanel.render(100).join("\n"), /y confirm delete/);
      statsPanel.handleInput("escape");
      assert.equal((await listMemories(a)).length, 2);
    } finally { statsPanel.dispose(); }
    const disposable = await saveMemory(a, "project", "ui-delete", "delete through memory panel");
    const deletePanel = createPanel({ cwd: a } as never, { terminal: { rows: 30 }, requestRender() {} } as never, { fg: (_color: string, text: string) => text } as never, () => {});
    try {
      deletePanel.handleInput("tab");
      deletePanel.handleInput("tab");
      deletePanel.handleInput("ui-delete");
      deletePanel.handleInput("return");
      for (let i = 0; i < 100 && !deletePanel.render(100).join("\n").includes("delete through memory panel"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      deletePanel.handleInput("down");
      deletePanel.handleInput("return");
      deletePanel.handleInput("ctrl+d");
      deletePanel.handleInput("return");
      assert.ok(await getMemory(a, disposable.id));
      deletePanel.handleInput("y");
      for (let i = 0; i < 100 && !deletePanel.render(100).join("\n").includes("Deleted memory"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(await getMemory(a, disposable.id), undefined);
      assert.match(deletePanel.render(100).join("\n"), /Deleted memory/);
    } finally { deletePanel.dispose(); }
    const stats = await memoryStats(a);
    assert.equal(stats.total, 2);
    assert.equal(stats.indexed, 2);
    const debug = await debugRetrieval(a, "query");
    assert.equal(debug.total, 2);
    assert.equal(debug.rows.length, 2);
    assert.match(debug.strategy, /Exact cosine/);
    assert.deepEqual((await listMemories(a)).map((row) => row.content).sort(), ["global preference", "project A decision"]);
    assert.deepEqual((await searchMemories(a, "query")).map((row) => row.content).sort(), ["global preference", "project A decision"]);
    let closed = false;
    const context = { mode: "tui", cwd: a, ui: { custom: async (factory: any) => {
      const panel = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => { closed = true; });
      panel.handleInput("tab");
      panel.handleInput("query");
      panel.handleInput("return");
      for (let i = 0; i < 50 && !panel.render(100).join("\n").includes("project A decision"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(panel.render(100).join("\n"), /project A decision/);
      panel.handleInput("down");
      panel.handleInput("return");
      assert.match(panel.render(100).join("\n"), /Source:/);
      panel.handleInput("escape");
      panel.handleInput("ctrl+s");
      assert.match(panel.render(100).join("\n"), /Scope: Global only/);
      panel.handleInput("escape");
    } } };
    await searchPanel(context as never);
    assert.equal(closed, true);
    await assert.rejects(deleteMemory(b, projectA.id), /not found/);
    await updateMemory(a, projectA.id, "updated decision");
    const history = await memoryHistory(a, projectA.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].content, "project A decision");
    await updateMemory(a, projectA.id, "updated decision");
    assert.equal((await memoryHistory(a, projectA.id)).length, 1);
    await assert.rejects(memoryHistory(b, projectA.id), /not found/);
    await assert.rejects(updateMemory(b, projectA.id, "wrong project"), /not found/);
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
    const unindexedStats = await memoryStats(a);
    assert.equal(unindexedStats.total - unindexedStats.indexed, 1);
    process.env.GEMINI_API_KEY = "test-key";
    const other = await saveMemory(a, "project", "decision", "other decision");
    await assert.rejects(updateMemory(a, other.id, "updated decision"), /Duplicate/);
    assert.equal((await memoryHistory(a, other.id)).length, 0);
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
