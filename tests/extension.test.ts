// Drives the extension's hooks with a fake Pi API: no model calls.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../task-memory/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Entry = { type: string; customType?: string; details?: Record<string, unknown> };
type Result = { entries?: Entry[]; continue?: boolean; block?: boolean } | undefined;
type ToolResult = { content: Array<{ text: string }>; terminate?: boolean };
type Tool = {
  prepareArguments: (args: unknown) => Record<string, unknown>;
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
};

const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function harness(mode: "tui" | "print") {
  const handlers = new Map<string, Handler[]>();
  let tool: Tool | undefined;
  let widget: { render: (width: number) => string[] } | undefined;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tm-ext-"));
  dirs.push(cwd);
  fs.mkdirSync(path.join(cwd, ".git"));
  const usage = { percent: 5 as number | null };
  const pi = {
    on: (name: string, h: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); return () => {}; },
    registerTool: (t: Tool) => { tool = t; },
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    getSettings: () => ({}),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  const ctx = {
    cwd, mode, hasUI: mode === "tui",
    ui: { notify: () => {}, setWidget: (_name: string, factory: (tui: unknown, theme: unknown) => { render: (width: number) => string[] }) => {
      widget = factory({ requestRender: () => {} }, { fg: (_color: string, text: string) => text });
    }, confirm: async () => true },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: usage.percent }),
    model: { contextWindow: 200000 },
  };
  extension(pi as never);
  const emit = async (name: string, event: Record<string, unknown> = {}): Promise<Result> => {
    let r: unknown;
    for (const h of handlers.get(name) ?? []) r = await h({ type: name, ...event }, ctx);
    return r as Result;
  };
  const call = (args: Record<string, unknown>) => tool!.execute("id", tool!.prepareArguments(args), undefined, undefined, ctx);
  return { emit, call, usage, cwd, widgetLines: () => widget!.render(120) };
}

test("widget reflects task changes made outside this session", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  await h.call({ action: "start", title: "External task", goal: "G" });
  assert.match(h.widgetLines()[0]!, /External task/);
  fs.rmSync(path.join(h.cwd, ".pi", "memory", "task.json"));
  assert.doesNotMatch(h.widgetLines()[0]!, /External task/);
  assert.match(h.widgetLines()[0]!, /no active task/i);
});

const busy = { entries: [], toolResults: [{}], outcome: "completed" };
const ending = { entries: [], toolResults: [], outcome: "completed" };

test("40%: mandatory handoff blocks other tools; automatic handoff after 3 ignored turns", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  await h.call({ action: "start", title: "T", goal: "G", steps: ["a", "b"] });
  h.usage.percent = 45;
  const r1 = await h.emit("turn_end", busy);
  assert.equal(r1?.entries?.[0]?.customType, "task-memory-must");
  assert.equal(r1?.continue, true);
  assert.equal((await h.emit("tool_call", { toolName: "read" }))?.block, true);
  assert.equal(await h.emit("tool_call", { toolName: "task" }), undefined);
  assert.equal(await h.emit("turn_end", busy), undefined);
  assert.equal(await h.emit("turn_end", busy), undefined);
  const r4 = await h.emit("turn_end", busy);
  assert.equal(r4?.entries?.[0]?.type, "compaction");
  assert.equal(r4?.entries?.[0]?.details?.auto, true);
  assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
});

test("checkpoint without `action` is inferred; mandatory handoff compacts mid-run", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  await h.call({ action: "start", title: "T", goal: "G", steps: ["a"] });
  h.usage.percent = 45;
  await h.emit("turn_end", busy);
  const res = await h.call({ next: "do a", readNow: [{ path: "x.ts", reason: "r" }], compact: true });
  assert.equal(res.terminate, false);
  assert.match(res.content[0]!.text, /Handoff #1 saved/);
  const r = await h.emit("turn_end", busy);
  assert.equal(r?.entries?.[0]?.type, "compaction");
  assert.equal(r?.entries?.[0]?.details?.checkpoint, 1);
});

test("TUI: warning at the end of a run asks for a handoff; the checkpoint stops the run; no task is created", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  h.usage.percent = 30;
  assert.equal(await h.emit("turn_end", ending), undefined);
  const s = await h.emit("agent_before_settle", { entries: [], outcome: "completed" });
  assert.equal(s?.entries?.[0]?.customType, "task-memory-handoff");
  assert.equal(s?.continue, true);
  const res = await h.call({ action: "checkpoint", next: "nothing left" });
  assert.equal(res.terminate, true);
  assert.equal(fs.existsSync(path.join(h.cwd, ".pi", "memory", "task.json")), false);
});

test("print mode: no extra turn after the final answer; 40% uses an automatic handoff", async () => {
  const h = harness("print");
  await h.emit("session_start");
  h.usage.percent = 30;
  assert.equal(await h.emit("turn_end", ending), undefined);
  assert.equal(await h.emit("agent_before_settle", { entries: [], outcome: "completed" }), undefined);
  await h.emit("agent_settled");
  h.usage.percent = 45;
  const r = await h.emit("turn_end", ending);
  assert.equal(r?.entries?.[0]?.type, "compaction");
  assert.equal(r?.continue, undefined);
});
