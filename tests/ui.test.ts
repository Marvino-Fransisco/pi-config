import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/ui/index.ts";
import { contextReport, registerContextCommand } from "../extensions/ui/context.ts";
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
    },
    getContextUsage: () => ({ percent: 30 }),
    sessionManager: { getCwd: () => "/project" },
    model: { id: "test-model", reasoning: true },
    thinkingLevel: "medium",
  };
  extension({ registerCommand: () => {}, on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler); } } as never);
  handlers.get("session_start")!({}, ctx);
  editor.lines = ["───", "input", "───", "suggestion"];
  editor.autocomplete = true;
  assert.deepEqual(editor.render(80), ["suggestion", "───", "input", "───"]);
  assert.match(footer.render(100)[0], /test-model • medium/);
  assert.doesNotMatch(footer.render(100)[0], /30%|WATCH|▰|▱/);
  assert.match(widget.render(100)[0], /\/project \(main\)/);
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
  const grid = lines.slice(1, 11).map((line) => line.split("  ")[0]).join("");
  assert.equal((grid.match(/[⛀⛁]/g) ?? []).length, 20);
  assert.equal((grid.match(/⛝/g) ?? []).length, 20);
  assert.match(lines[1]!, /model/);
  assert.match(report, /100 \/ 1,000 tokens \(10.0%\)/);
  assert.match(report, /Summaries:/);
  assert.match(report, /Legend: at least one symbol/);
  assert.match(report, /\x1b\[38;2;/);
  assert.match(report, /Unattributed/);
  assert.match(report, /Free space/);
  assert.match(report, /Configured Pi reserve: 100/);
  assert.ok(report.indexOf("  bash:") < report.indexOf("  read:"));
  assert.match(report, /not provider token counts/);
  assert.match(report, /not tool schemas or earlier compacted history/);
});

test("context grid gives small non-zero categories visible dots", () => {
  const ctx = {
    model: { id: "model", contextWindow: 1_000_000 },
    getContextUsage: () => ({ tokens: 23, contextWindow: 1_000_000, percent: 0.0023 }),
    getSystemPrompt: () => "x".repeat(18_816),
    sessionManager: { buildSessionProjection: () => ({ entries: [{ messages: [{ role: "user", content: "hello" }] }] }) },
  };
  const lines = contextReport(ctx as never);
  const grid = lines.slice(1, 11).map((line) => line.split("  ")[0]).join("");
  assert.match(grid, /\x1b\[38;2;105;180;255m⛀/);
  assert.match(grid, /\x1b\[38;2;95;225;220m⛁/);
  assert.equal((grid.match(/[⛀⛁]/g) ?? []).length, 2);
  assert.equal((grid.match(/⛶/g) ?? []).length, 198);
  assert.match(lines.join("\n"), /at least one symbol per non-zero category/);
  const narrow = contextReport(ctx as never, 70);
  assert.doesNotMatch(narrow[1]!, /model/);
  assert.ok(narrow.slice(1, 11).every((row) => row.split("⛶").length > 1));
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
  const tui = { terminal: { columns: 120, rows: 30 }, requestRender() {}, showOverlay(component: unknown, options: { width: string }) { panel = component; overlayWidth = options.width; return { hide() {}, focus() {}, isFocused: () => true }; } };
  const notes = createNotes(tui as never, { fg: (_color: string, text: string) => text } as never, () => "task", () => {}, (width) => { widths.push(width); return `width ${width}`; });
  notes.open("context");
  assert.equal(overlayWidth, "65%");
  panel.render(100);
  panel.render(80);
  panel.render(80);
  assert.deepEqual(widths.slice(-2), [98, 78]);
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
      assert.match(component.render(100).join("\n"), /Context usage/);
      component.handleInput("down");
      component.handleInput("q");
    } },
  };
  registerContextCommand({ registerCommand: (_name: string, value: unknown) => { command = value; } } as never);
  await command.handler("", ctx);
  assert.equal(closed, true);
});

test("context command uses the shared task panel when available", async () => {
  let command: any;
  const events = { on() {}, emit(name: string, request: { handled: boolean }) { if (name === "task-memory:panel:open") request.handled = true; } };
  registerContextCommand({ events, registerCommand: (_name: string, value: unknown) => { command = value; } } as never);
  await command.handler("", { mode: "tui", model: undefined, getContextUsage: () => undefined, getSystemPrompt: () => "", sessionManager: { buildSessionProjection: () => ({ entries: [] }) }, ui: { custom() { throw new Error("unexpected standalone screen"); } } });
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
  extension({ events, registerCommand: () => {}, on: (name: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(name, handler); } } as never);
  handlers.get("agent_start")!({}, ctx);
  available = false;
  handlers.get("agent_start")!({}, ctx);
  handlers.get("session_shutdown")!({}, ctx);
  assert.deepEqual(visibility, [false, true, true]);
});
