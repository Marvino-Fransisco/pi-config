import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/ui/tui-custom.ts";

test("installs the editor, footer and topbar with shared branch data", () => {
  let start: ((event: unknown, ctx: unknown) => void) | undefined;
  let editor: any;
  let footer: any;
  let widget: any;
  const footerData = { getGitBranch: () => "main", onBranchChange: () => () => {} };
  const ctx = {
    ui: {
      setEditorComponent: (factory: (...args: unknown[]) => unknown) => { editor = factory({}, {}, {}); },
      setFooter: (factory: (...args: unknown[]) => unknown) => { footer = factory({}, {}, footerData); },
      setWidget: (_name: string, factory: (...args: unknown[]) => unknown) => { widget = factory({ requestRender() {} }, {}); },
    },
    getContextUsage: () => ({ percent: 30 }),
    sessionManager: { getCwd: () => "/project" },
    model: { id: "test-model", reasoning: true },
    thinkingLevel: "medium",
  };
  extension({ on: (_name: string, handler: typeof start) => { start = handler; } } as never);
  start!({}, ctx);
  editor.lines = ["───", "input", "───", "suggestion"];
  editor.autocomplete = true;
  assert.deepEqual(editor.render(80), ["suggestion", "───", "input", "───"]);
  assert.match(footer.render(100)[0], /30%.*WATCH.*test-model • medium/);
  assert.match(widget.render(100)[0], /\/project \(main\)/);
});
