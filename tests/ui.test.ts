import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/ui/index.ts";
import { contextReport, registerContextCommand } from "../extensions/ui/context.ts";
import { registerDashboard } from "../extensions/ui/dashboard.ts";
import { installContextFooter } from "../extensions/ui/footer/context-footer.ts";
import { createNotes } from "../extensions/task-memory/ui/notes.ts";

test("installs the editor, footer and topbar with shared branch data", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  let editor: any;
  let footer: any;
  let widget: any;
  const footerData = { getGitBranch: () => "main", onBranchChange: () => () => {} };
  const ctx = {
    mode: "tui",
    ui: {
      setWorkingIndicator: () => {},
      setEditorComponent: (factory: (...args: unknown[]) => unknown) => { editor = factory({}, {}, {}); },
      setFooter: (factory: (...args: unknown[]) => unknown) => { footer = factory({}, {}, footerData); },
      setWidget: (_name: string, factory: (...args: unknown[]) => unknown) => { widget = factory({ requestRender() {} }, {}); },
      setHeader: () => {},
    },
    getContextUsage: () => ({ percent: 30 }),
    sessionManager: { getCwd: () => "/project", getBranch: () => [] },
    model: { id: "test-model", reasoning: true },
    thinkingLevel: "medium",
  };
  extension({ registerCommand: () => {}, registerShortcut: () => {}, getCommands: () => [], on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler); } } as never);
  handlers.get("session_start")!({}, ctx);
  editor.lines = ["───", "input", "───", "suggestion"];
  editor.autocomplete = true;
  assert.deepEqual(editor.render(80), ["suggestion", "───", "input", "───"]);
  assert.match(footer.render(100)[0], /test-model • medium/);
  assert.doesNotMatch(footer.render(100)[0], /30%|WATCH|▰|▱/);
  assert.match(widget.render(100)[0], /\/project \(main\)/);
});

test("fresh session dashboard is centered, runs actions and slides away on the first message", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const sent: string[] = [];
  let header: any;
  let overlay: any;
  let options: any;
  let branch: Array<{ type: string }> = [];
  const tui = {
    terminal: { rows: 40, columns: 100 },
    requestRender() {},
    showOverlay: (component: unknown, opts: unknown) => { overlay = component; options = opts; return { hide: () => { overlay = undefined; } }; },
  };
  const ctx = {
    mode: "tui",
    ui: { setHeader: (factory: any) => { header?.dispose?.(); header = factory?.(tui, {}); }, notify: () => {} },
    sessionManager: { getCwd: () => "/project", getBranch: () => branch },
    model: { id: "test-model", reasoning: true },
    thinkingLevel: "high",
  };
  const listeners: Array<(data: any) => void> = [];
  registerDashboard({
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler); },
    getCommands: () => [{ name: "task" }, { name: "context" }],
    sendUserMessage: (text: string) => { sent.push(text); },
    events: { on: (_name: string, handler: (data: any) => void) => { listeners.push(handler); }, emit: (_name: string, data: unknown) => { for (const l of listeners) l(data); } },
  } as never, () => undefined);
  listeners.push((data) => data.push({ title: "Active task", lines: ["Build dashboard · step 1/3"] }));

  handlers.get("session_start")!({ reason: "startup" }, ctx);
  assert.deepEqual(header.render(100), []);
  const lines: string[] = overlay.render(100);
  assert.equal(options.nonCapturing, true);
  assert.equal(options.row, Math.floor((40 - 6 - lines.length) / 2));
  const colored = lines.join("\n");
  const text = colored.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /██████╗/);
  assert.match(text, /test-model • high/);
  assert.match(text, /Build dashboard · step 1\/3/);
  assert.match(text, /click to run/);
  assert.match(text, /› Context usage/);
  assert.doesNotMatch(text, /alt\+/);
  assert.doesNotMatch(text, /Long-term memory/);

  assert.doesNotMatch(colored.replace(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g, (_m, r, g, b) => (Number(b) >= Number(r) && Number(b) >= Number(g) ? "" : "NOT_BLUE")), /NOT_BLUE/);
  overlay.handleMouse({ type: "click", y: lines.findIndex((l) => l.includes("Task notes")) });
  overlay.handleMouse({ type: "click", y: lines.findIndex((l) => l.includes("Resume active task")) });
  overlay.handleMouse({ type: "click", y: 0 });
  assert.deepEqual(sent, ["/task", "/task resume"]);

  const start = options.row;
  handlers.get("input")!({ text: "hi" }, ctx);
  t.mock.timers.tick(150);
  overlay.render(100);
  assert.ok(options.row < start);
  t.mock.timers.tick(300);
  assert.equal(overlay, undefined);

  branch = [{ type: "message" }];
  handlers.get("session_start")!({ reason: "new" }, ctx);
  assert.equal(header, undefined);
  assert.equal(overlay, undefined);
});

test("context report ranks only projected tool results and labels estimates", () => {
  const entries = [
    { messages: [{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "a".repeat(80) }] }] },
    { messages: [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "a".repeat(400) }] }] },
    { messages: [{ role: "compactionSummary", summary: "previous work" }] },
    { messages: [] },
  ];
  const ctx = { model: { id: "model", contextWindow: 1000 }, getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }), getSystemPrompt: () => "abcd", sessionManager: { buildSessionProjection: () => ({ entries }) } };
  const lines = contextReport(ctx as never, 100, 100);
  const report = lines.join("\n");
  const grid = lines.slice(0, 10).map((line) => line.split("  ")[0]).join("");
  assert.equal((grid.match(/[⛀⛁]/g) ?? []).length, 20);
  assert.equal((grid.match(/⛝/g) ?? []).length, 20);
  assert.match(lines[0]!, /model/);
  assert.match(report, /100 \/ 1,000 tokens \(10.0%\)/);
  assert.match(report, /Summaries:/);
  assert.doesNotMatch(report, /Context usage|Legend: at least one symbol|Grid is approximate/);
  assert.match(report, /\x1b\[38;2;/);
  assert.match(report, /Unattributed/);
  assert.match(report, /Free space/);
  assert.match(report, /Configured Pi reserve: 100/);
  assert.ok(report.indexOf(" bash:") < report.indexOf(" read:"));
  assert.match(report, /\x1b\[38;2;105;180;255m◆\x1b\[39m bash:/);
  assert.match(report, /\x1b\[38;2;95;225;220m◆\x1b\[39m read:/);
});

test("context grid gives small non-zero categories visible dots", () => {
  const ctx = {
    model: { id: "model", contextWindow: 1_000_000 },
    getContextUsage: () => ({ tokens: 23, contextWindow: 1_000_000, percent: 0.0023 }),
    getSystemPrompt: () => "x".repeat(18_816),
    sessionManager: { buildSessionProjection: () => ({ entries: [{ messages: [{ role: "user", content: "hello" }] }] }) },
  };
  const lines = contextReport(ctx as never);
  const grid = lines.slice(0, 10).map((line) => line.split("  ")[0]).join("");
  assert.match(grid, /\x1b\[38;2;105;180;255m⛀/);
  assert.match(grid, /\x1b\[38;2;95;225;220m⛁/);
  assert.equal((grid.match(/[⛀⛁]/g) ?? []).length, 2);
  assert.equal((grid.match(/⛶/g) ?? []).length, 198);
  assert.doesNotMatch(lines.join("\n"), /at least one symbol per non-zero category/);
  const narrow = contextReport(ctx as never, 70);
  assert.doesNotMatch(narrow[0]!, /model/);
  assert.ok(narrow.slice(0, 10).every((row) => row.split("⛶").length > 1));
});

test("context report resolves model-specific and disabled compaction reserves", () => {
  let onRead: (request: any) => void = () => {};
  let settings: any = { compaction: { reserveTokens: 100, modelOverrides: { "provider/model": { reserveTokens: 200 } } } };
  const pi = { events: { on: (_name: string, handler: typeof onRead) => { onRead = handler; } }, getSettings: () => settings, registerCommand() {} };
  registerContextCommand(pi as never);
  const ctx = { model: { provider: "provider", id: "model", contextWindow: 1000 }, getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }), getSystemPrompt: () => "", sessionManager: { buildSessionProjection: () => ({ entries: [] }) } };
  const read = () => { const request: { ctx: typeof ctx; width: number; lines?: string[] } = { ctx, width: 100 }; onRead(request); return request.lines!.join("\n"); };
  assert.match(read(), /Configured Pi reserve: 200/);
  settings = { compaction: { enabled: false } };
  assert.match(read(), /Auto-compaction reserve: disabled/);
  settings = {};
  assert.match(read(), /Configured Pi reserve: 16,384/);
  const unknown = contextReport({ ...ctx, getContextUsage: () => undefined } as never).join("\n");
  assert.match(unknown, /Context grid unavailable until usage is known/);
  assert.match(unknown, /Free space: unknown/);
});

test("context panel recomputes layout when its width changes", () => {
  let panel: any;
  const widths: number[] = [];
  let overlayWidth: string | undefined;
  let focused = false;
  const tui = { terminal: { columns: 120, rows: 30 }, requestRender() {}, showOverlay(component: unknown, options: { width: string }) { panel = component; overlayWidth = options.width; return { hide() {}, focus() { focused = true; }, unfocus() { focused = false; }, isFocused: () => focused }; } };
  const notes = createNotes(tui as never, { fg: (_color: string, text: string) => text } as never, (width) => { widths.push(width); return `width ${width}`; }, () => {}, "context");
  notes.open();
  assert.equal(overlayWidth, "65%");
  panel.render(100);
  panel.render(80);
  panel.render(80);
  assert.deepEqual(widths.slice(-2), [98, 78]);
  panel.handleInput("escape");
  assert.equal(focused, false);
  panel.handleMouse({ type: "press", button: "left" });
  assert.equal(focused, true);
  panel.handleInput("escape");
  panel.handleMouse({ type: "click", button: "left" });
  assert.equal(focused, true);
  notes.close();
});

test("context command opens a scrollable TUI and closes without starting an agent turn", async () => {
  let command: any;
  let closed = false;
  const ctx = {
    mode: "tui", model: undefined, getContextUsage: () => undefined, getSystemPrompt: () => "",
    sessionManager: { buildSessionProjection: () => ({ entries: [] }) },
    ui: { custom: async (factory: any) => {
      const component = factory({ terminal: { rows: 10 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => { closed = true; });
      assert.match(component.render(100).join("\n"), /Context grid unavailable/);
      component.handleInput("down");
      component.handleInput("q");
    } },
  };
  registerContextCommand({ registerCommand: (_name: string, value: unknown) => { command = value; } } as never);
  await command.handler("", ctx);
  assert.equal(closed, true);
});

test("context fallback announces replacement without depending on task-memory", async () => {
  let command: any;
  let opening = "";
  const events = { on() {}, emit(name: string, request: { name: string }) { if (name === "ui:panel:opening") opening = request.name; } };
  registerContextCommand({ events, registerCommand: (_name: string, value: unknown) => { command = value; } } as never);
  await command.handler("", { mode: "tui", model: undefined, getContextUsage: () => undefined, getSystemPrompt: () => "", sessionManager: { buildSessionProjection: () => ({ entries: [] }) }, ui: { custom() {} } });
  assert.equal(opening, "context");
});

test("model footer is hidden only when the shared task row is available", () => {
  let footer: any;
  let shared = false;
  const ctx = { model: { id: "test" }, ui: { setFooter: (factory: any) => { footer = factory({}, {}, {}); } } };
  installContextFooter(ctx as never, () => shared);
  assert.match(footer.render(80)[0], /test/);
  shared = true;
  assert.deepEqual(footer.render(80), []);
});

test("working indicator is hidden only when the task widget is available", () => {
  const handlers = new Map<string, (event: unknown, ctx: any) => void>();
  const visibility: boolean[] = [];
  let available = true;
  const ctx = { mode: "tui", ui: {
    setWorkingVisible: (value: boolean) => { visibility.push(value); },
    setEditorComponent: () => {}, setFooter: () => {}, setWidget: () => {},
  } };
  const events = { on() {}, emit(name: string, request: { available: boolean }) { if (name === "task-memory:footer:available") request.available = available; } };
  extension({ events, registerCommand: () => {}, registerShortcut: () => {}, on: (name: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(name, handler); } } as never);
  handlers.get("agent_start")!({}, ctx);
  available = false;
  handlers.get("agent_start")!({}, ctx);
  handlers.get("session_shutdown")!({}, ctx);
  assert.deepEqual(visibility, [false, true, true]);
});
