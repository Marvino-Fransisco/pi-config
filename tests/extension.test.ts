// Drives the extension's hooks with a fake Pi API: no model calls.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/task-memory/index.ts";

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
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  let panel: { render: (width: number) => string[]; handleInput: (data: string) => void; handleMouse: (event: { type: string; button: string; wheelDelta?: number }) => { handled?: boolean; focus?: boolean } | undefined } | undefined;
  let shortcut: { handler: (ctx: unknown) => Promise<void> } | undefined;
  let focused = false;
  let visible: ((width: number, height: number) => boolean) | undefined;
  const terminal = { columns: 120, rows: 30 };
  const tui = {
    terminal,
    requestRender: () => {},
    showOverlay: (component: typeof panel, options: { visible: typeof visible }) => {
      panel = component;
      visible = options.visible;
      return {
        hide: () => { panel = undefined; focused = false; },
        focus: () => { focused = true; },
        unfocus: () => { focused = false; },
        isFocused: () => focused,
      };
    },
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tm-ext-"));
  dirs.push(cwd);
  fs.mkdirSync(path.join(cwd, ".git"));
  const usage = { percent: 5 as number | null };
  const notifications: string[] = [];
  const pi = {
    on: (name: string, h: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); return () => {}; },
    registerTool: (t: Tool) => { tool = t; },
    registerMessageRenderer: () => {},
    registerCommand: (_name: string, c: typeof command) => { command = c; },
    registerShortcut: (_key: string, s: typeof shortcut) => { shortcut = s; },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    getSettings: () => ({}),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  const ctx = {
    cwd, mode, hasUI: mode === "tui",
    ui: { notify: (message: string) => { notifications.push(message); }, setWidget: (_name: string, factory: (tui: unknown, theme: unknown) => { render: (width: number) => string[] }) => {
      widget = factory(tui, { fg: (_color: string, text: string) => text });
    }, confirm: async () => true },
    isIdle: () => true,
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
  return { emit, call, usage, cwd, terminal, notifications, widgetLines: () => widget!.render(120), command: (args: string) => command!.handler(args, ctx), panel: () => panel, focus: () => shortcut!.handler(ctx), isFocused: () => focused, visible: (width: number, height: number) => visible!(width, height) };
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

test("task notes stay open, update from disk, scroll and release focus", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  await h.call({ action: "start", title: "Panel task", goal: "G", steps: Array.from({ length: 14 }, (_, i) => `step ${i}`) });
  await h.command("");
  const rows = h.panel()!.render(50);
  assert.match(rows.join("\n"), /Panel task/);
  assert.ok(rows.every((row) => [...row].length === 50));
  assert.ok(rows.slice(1, -1).every((row) => row.startsWith("┃") && row.endsWith("┃")));
  assert.deepEqual(h.panel()!.handleMouse({ type: "press", button: "left" }), { handled: true, focus: true });
  assert.equal(h.isFocused(), false);
  assert.equal(h.visible(79, 30), false);
  assert.equal(h.visible(120, 11), false);
  assert.equal(h.visible(120, 30), true);
  await h.focus();
  assert.equal(h.isFocused(), true);
  h.panel()!.render(50);
  assert.deepEqual(h.panel()!.handleMouse({ type: "wheel", button: "none", wheelDelta: 1 }), { handled: true });
  assert.doesNotMatch(h.panel()!.render(50).join("\n"), /## Active task/);
  h.panel()!.handleInput("escape");
  assert.equal(h.isFocused(), false);
  fs.rmSync(path.join(h.cwd, ".pi", "memory", "task.json"));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.match(h.panel()!.render(50).join("\n"), /No active task/);
  await h.command("");
  assert.equal(h.panel(), undefined);
  await h.emit("session_shutdown");
});

test("task tool persists and archives a completed task", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  await h.call({ action: "start", title: "Lifecycle", goal: "G", steps: ["work"] });
  await h.call({ action: "step", id: 1, status: "doing" });
  await h.call({ action: "step", id: 1, status: "done", evidence: "manual: verified" });
  assert.match((await h.call({ action: "finish", evidence: "manual: verified", docs: "none: internal" })).content[0]!.text, /archived/);
  assert.match((await h.call({ action: "show" })).content[0]!.text, /No active task/);
  assert.match(h.widgetLines()[0]!, /no active task/i);
});

const busy = { entries: [], toolResults: [{}], outcome: "completed" };
const ending = { entries: [], toolResults: [], outcome: "completed" };

test("75%: mandatory handoff blocks other tools; automatic handoff after 3 ignored turns", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  await h.call({ action: "start", title: "T", goal: "G", steps: ["a", "b"] });
  h.usage.percent = 80;
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
  h.usage.percent = 80;
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
  h.usage.percent = 55;
  assert.equal(await h.emit("turn_end", ending), undefined);
  const s = await h.emit("agent_before_settle", { entries: [], outcome: "completed" });
  assert.equal(s?.entries?.[0]?.customType, "task-memory-handoff");
  assert.equal(s?.continue, true);
  const res = await h.call({ action: "checkpoint", next: "nothing left" });
  assert.equal(res.terminate, true);
  assert.equal(fs.existsSync(path.join(h.cwd, ".pi", "memory", "task.json")), false);
});

test("thinking phase uses a distinct icon", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  await h.emit("agent_start");
  const first = h.widgetLines()[0]!;
  assert.match(first.replace(/\x1b\[[\d;]*m/g, ""), /✦ thinking/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.notEqual(h.widgetLines()[0]!, first);
  await h.emit("agent_settled");
});

test("threshold command validates, persists and applies independent values", async () => {
  const h = harness("tui");
  await h.emit("session_start");
  await h.command("threshold");
  assert.match(h.notifications.at(-1)!, /warning 50%, mandatory 75%/);
  await h.command("threshold warning 20");
  await h.command("threshold mandatory 65");
  await h.command("threshold warning 70");
  assert.match(h.notifications.at(-1)!, /lower than mandatory/);
  await h.command("threshold must nope");
  assert.match(h.notifications.at(-1)!, /Usage/);
  await h.emit("session_start");
  await h.command("threshold");
  assert.match(h.notifications.at(-1)!, /warning 20%, mandatory 65%/);
  h.usage.percent = 20;
  assert.equal((await h.emit("turn_end", busy))?.entries?.[0]?.customType, "task-memory-warn");
  h.usage.percent = 65;
  assert.equal((await h.emit("turn_end", busy))?.entries?.[0]?.customType, "task-memory-must");
});

test("print mode: no extra turn after the final answer; 75% uses an automatic handoff", async () => {
  const h = harness("print");
  await h.emit("session_start");
  h.usage.percent = 55;
  assert.equal(await h.emit("turn_end", ending), undefined);
  assert.equal(await h.emit("agent_before_settle", { entries: [], outcome: "completed" }), undefined);
  await h.emit("agent_settled");
  h.usage.percent = 80;
  const r = await h.emit("turn_end", ending);
  assert.equal(r?.entries?.[0]?.type, "compaction");
  assert.equal(r?.continue, undefined);
});
