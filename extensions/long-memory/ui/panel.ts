import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { searchMemories, type MemoryRow, type Scope } from "../src/store.ts";

export function safeText(value: string): string {
  return [...value].filter((char) => { const code = char.codePointAt(0)!; return code === 10 || code === 9 || (code >= 32 && (code < 127 || code > 159)); }).join("");
}

export function formatMemory(memory: MemoryRow, preview = false): string {
  const scope = memory.project_id === null ? "global" : "project";
  const similarity = memory.similarity === undefined ? "" : ` · similarity ${(memory.similarity * 100).toFixed(1)}%`;
  const indexed = memory.indexed === false ? " · not indexed" : "";
  const content = safeText(memory.content);
  const displayed = preview && content.length > 300 ? `${content.slice(0, 300)}… (use show for full content)` : content;
  return `#${memory.id} · ${scope} · ${safeText(memory.kind)}${similarity}${indexed}\n${displayed}\nSource: ${safeText(memory.source)} · Updated: ${memory.updated_at}`;
}

export async function showText(ctx: ExtensionContext, title: string, text: string): Promise<void> {
  const clean = safeText(text);
  if (ctx.mode !== "tui") { ctx.ui.notify(`${title}\n${clean}`); return; }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let offset = 0;
    let maxOffset = 0;
    return {
      invalidate() {},
      render(width: number) {
        const height = Math.max(1, tui.terminal.rows - 4);
        const lines = clean.split("\n").flatMap((line) => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]);
        maxOffset = Math.max(0, lines.length - height);
        offset = Math.min(offset, maxOffset);
        return [truncateToWidth(theme.fg("accent", title), width), ...lines.slice(offset, offset + height), truncateToWidth(theme.fg("dim", "↑↓ scroll · Esc close"), width)];
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape") || data === "q") { done(); return; }
        if (matchesKey(data, "up") || data === "k") offset = Math.max(0, offset - 1);
        else if (matchesKey(data, "down") || data === "j") offset = Math.min(maxOffset, offset + 1);
        else return;
        tui.requestRender();
      },
    };
  });
}

export async function searchPanel(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/memory requires interactive TUI mode", "error"); return; }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const input = new Input({ prompt: "Search: ", placeholder: "Semantic search (sent to Google)" });
    let focused = true;
    let selected = -1;
    let rows: MemoryRow[] = [];
    let detail: MemoryRow | undefined;
    let detailOffset = 0;
    let detailMaxOffset = 0;
    let scope: Scope = "both";
    let status = "Enter to search · Tab scope · ↑↓ select · Esc close";
    let sequence = 0;
    let closed = false;
    input.onSubmit = (value) => {
      if (selected >= 0 && rows[selected]) { detail = rows[selected]; detailOffset = 0; tui.requestRender(); return; }
      const query = value.trim();
      if (!query) { status = "Enter a search query."; tui.requestRender(); return; }
      const current = ++sequence;
      status = "Searching…";
      tui.requestRender();
      void searchMemories(ctx.cwd, query, scope).then((result) => {
        if (closed || current !== sequence) return;
        rows = result;
        selected = -1;
        status = result.length ? `${result.length} results · ↑↓ select · Enter detail` : "No matching memories.";
        tui.requestRender();
      }).catch((error: unknown) => {
        if (closed || current !== sequence) return;
        rows = [];
        status = `Search failed: ${error instanceof Error ? error.message : String(error)}`;
        tui.requestRender();
      });
    };
    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value; },
      invalidate() { input.invalidate(); },
      dispose() { closed = true; sequence++; },
      render(width: number) {
        input.focused = focused;
        const height = Math.max(1, tui.terminal.rows - 6);
        const detailLines = detail ? formatMemory(detail).split("\n").flatMap((line) => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]) : [];
        detailMaxOffset = Math.max(0, detailLines.length - height);
        detailOffset = Math.min(detailOffset, detailMaxOffset);
        const lines = detail
          ? detailLines.slice(detailOffset, detailOffset + height)
          : rows.slice(Math.max(0, selected - height + 1), Math.max(0, selected - height + 1) + height).map((row) => truncateToWidth(`${rows[selected] === row ? ">" : " "} #${row.id} [${row.project_id === null ? "global" : "project"}] ${((row.similarity ?? 0) * 100).toFixed(1)}% ${safeText(row.content).replace(/\s+/g, " ")}`, width));
        return [truncateToWidth(theme.fg("accent", `Memory · ${scope === "both" ? "global + current project" : scope}`), width), ...input.render(width), truncateToWidth(theme.fg("dim", detail ? "↑↓ scroll · Esc back" : safeText(status)), width), ...lines];
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape")) {
          if (detail) { detail = undefined; tui.requestRender(); } else { closed = true; done(); }
          return;
        }
        if (detail) {
          if (matchesKey(data, "up")) detailOffset = Math.max(0, detailOffset - 1);
          else if (matchesKey(data, "down")) detailOffset = Math.min(detailMaxOffset, detailOffset + 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "tab")) {
          scope = scope === "both" ? "global" : scope === "global" ? "project" : "both";
          sequence++;
          rows = [];
          selected = -1;
          status = "Enter to search · Tab scope · ↑↓ select · Esc close";
        } else if (matchesKey(data, "up")) selected = Math.max(-1, selected - 1);
        else if (matchesKey(data, "down")) selected = Math.min(rows.length - 1, selected + 1);
        else {
          if (!matchesKey(data, "return")) {
            selected = -1;
            sequence++;
            status = "Enter to search · Tab scope · ↑↓ select · Esc close";
          }
          input.handleInput(data);
        }
        tui.requestRender();
      },
    };
  });
}
