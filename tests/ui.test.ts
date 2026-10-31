import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/ui/index.ts";
import { workingFrame } from "../extensions/ui/widget/working.ts";

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
  extension({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler); } } as never);
  handlers.get("session_start")!({}, ctx);
  editor.lines = ["───", "input", "───", "suggestion"];
  editor.autocomplete = true;
  assert.deepEqual(editor.render(80), ["suggestion", "───", "input", "───"]);
  assert.match(footer.render(100)[0], /30%.*WATCH.*test-model • medium/);
  assert.match(widget.render(100)[0], /\/project \(main\)/);
});

test("working animation rotates eight words and stops when settled", async () => {
  const strip = (text: string) => text.replace(/\x1b\[[\d;]*m/g, "");
  const words = Array.from({ length: 8 }, (_, index) => strip(workingFrame(index * 25)));
  assert.equal(new Set(words).size, 8);
  assert.equal(strip(workingFrame(200)), words[0]);
  assert.notEqual(workingFrame(0), workingFrame(1));
  const handlers = new Map<string, (event: unknown, ctx: any) => void>();
  const messages: Array<string | undefined> = [];
  let indicator: { frames: string[] } | undefined;
  const ctx = { mode: "tui", ui: {
    setWorkingIndicator: (value: typeof indicator) => { indicator = value; },
    setWorkingMessage: (value?: string) => { messages.push(value); },
    setEditorComponent: () => {}, setFooter: () => {}, setWidget: () => {},
  } };
  extension({ on: (name: string, handler: (event: unknown, ctx: any) => void) => { handlers.set(name, handler); } } as never);
  handlers.get("session_start")!({}, ctx);
  assert.ok(indicator!.frames.length > 1);
  assert.ok(new Set(indicator!.frames.map(strip)).size > 1);
  handlers.get("agent_start")!({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(messages.length >= 2);
  handlers.get("agent_settled")!({}, ctx);
  const count = messages.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(messages.length, count);
  assert.equal(messages.at(-1), undefined);
  handlers.get("agent_start")!({}, ctx);
  handlers.get("session_shutdown")!({}, ctx);
  const shutdownCount = messages.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(messages.length, shutdownCount);
  assert.equal(indicator, undefined);
});
