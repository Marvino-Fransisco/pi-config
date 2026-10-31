import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { debugRetrieval, deleteMemory, listMemories, memoryStats, queryMemory, searchMemories, type MemoryRow, type Scope } from "../src/store.ts";

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

export function formatTable(results: Awaited<ReturnType<typeof queryMemory>>): string {
  return results.map((result) => {
    const { columns, rows, truncated } = result as { columns: string[]; rows: unknown[][]; truncated: boolean };
    const values = [columns.map((column) => safeText(column).replace(/\s+/g, " ")), ...rows.map((row) => row.map((value) => safeText(value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/\s+/g, " ")))];
    const widths = columns.map((_, index) => Math.min(40, Math.max(1, ...values.map((row) => visibleWidth(row[index] ?? "")))));
    const line = (row: string[]) => "│ " + row.map((cell, index) => truncateToWidth(cell, widths[index], "…", true)).join(" │ ") + " │";
    const border = (left: string, middle: string, right: string) => left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
    return [border("┌", "┬", "┐"), line(values[0]), border("├", "┼", "┤"), ...values.slice(1).map(line), border("└", "┴", "┘"), truncated ? "Results limited to 100 rows." : `${rows.length} ${rows.length === 1 ? "row" : "rows"}`].join("\n");
  }).join("\n\n");
}

export function createPanel(ctx: ExtensionContext, tui: TUI, theme: Theme, done: () => void) {
    let input = new Input({ prompt: "> ", placeholder: "" });
    const modes = ["stats", "search", "list", "debug", "sql"] as const;
    let mode: typeof modes[number] = "stats";
    let page = 0;
    let listKind = "";
    let diagnostics = "";
    let output = "";
    let failed = false;
    let outputOffset = 0;
    let outputMaxOffset = 0;
    let focused = true;
    let selected = -1;
    let rows: MemoryRow[] = [];
    let detail: MemoryRow | undefined;
    let confirmingDelete = false;
    let deleting = false;
    let deleteError = "";
    let sqlOffset = 0;
    let sqlMaxOffset = 0;
    const color = (name: Parameters<Theme["fg"]>[0], text: string) => name === "accent" ? `\x1b[38;2;90;175;255m${text}\x1b[39m` : theme.fg(name, text);
    let detailOffset = 0;
    let detailMaxOffset = 0;
    let scope: Scope = "both";
    let status = "Enter to search (sent to Google)";
    let sequence = 0;
    let closed = false;
    input.onSubmit = (value) => {
      if (selected >= 0 && rows[selected]) { detail = rows[selected]; deleteError = ""; detailOffset = 0; tui.requestRender(); return; }
      const query = value.trim();
      if (mode === "list") listKind = query;
      if (mode !== "list" && mode !== "stats" && !query) { status = mode === "sql" ? "Enter a SQL query." : "Enter a search query."; tui.requestRender(); return; }
      const current = ++sequence;
      status = "Loading…";
      failed = false;
      output = "";
      rows = [];
      diagnostics = "";
      tui.requestRender();
      const operation = mode === "stats" ? memoryStats(ctx.cwd, scope).then((result) => ({ rows: [] as MemoryRow[], output: `OVERVIEW\n${result.total} memories · ${result.indexed} indexed · ${result.total - result.indexed} unindexed\n\nBY SCOPE / KIND\n${result.groups.map((group) => `${group.scope} / ${safeText(group.kind)}: ${group.total} (${group.indexed} indexed)`).join("\n") || "No memories saved yet."}\n\nSEARCH ENGINE\n${result.model} · ${result.dimensions} dimensions\nExact cosine · top 5 indexed memories` }))
        : mode === "debug" ? debugRetrieval(ctx.cwd, query, scope).then((result) => ({ rows: result.rows, output: "", diagnostics: `Exact cosine · top 5 · ${result.elapsedMs}ms\n${result.total} candidates · ${result.indexed} indexed · ${result.total - result.indexed} excluded (unindexed) · no threshold` }))
        : mode === "sql" ? queryMemory(query).then((result) => ({ rows: [] as MemoryRow[], output: formatTable(result) }))
        : (mode === "list" ? listMemories(ctx.cwd, scope, query || undefined, page * 50) : searchMemories(ctx.cwd, query, scope)).then((result) => ({ rows: result, output: "" }));
      void operation.then((result) => {
        if (closed || current !== sequence) return;
        rows = result.rows;
        output = result.output;
        diagnostics = "diagnostics" in result ? String(result.diagnostics) : "";
        outputOffset = 0;
        sqlOffset = 0;
        selected = -1;
        status = output ? "↑↓ scroll results" : rows.length ? `${rows.length} results${mode === "list" ? ` · page ${page + 1} · Ctrl+N/P page` : ""} · ↑↓ select · Enter detail` : "No matching memories.";
        tui.requestRender();
      }).catch((error: unknown) => {
        if (closed || current !== sequence) return;
        rows = [];
        failed = true;
        output = safeText(error instanceof Error ? error.message : String(error));
        outputOffset = 0;
        status = mode === "sql" ? "SQL query failed · Check the query and try again" : "Request failed · Check the details below";
        tui.requestRender();
      });
    };
    input.onSubmit("");
    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value; },
      invalidate() { input.invalidate(); },
      dispose() { closed = true; sequence++; },
      render(width: number) {
        input.focused = focused && mode !== "stats" && !detail;
        const height = Math.max(1, Math.min(12, tui.terminal.rows - 14) - (diagnostics ? 2 : 0));
        const detailText = detail ? [color("accent", `Memory #${detail.id} · ${detail.project_id === null ? "Global" : "Current project"}`), `Kind: ${safeText(detail.kind)}`, "", color("accent", "SAVED CONTENT"), safeText(detail.content), "", `Source: ${safeText(detail.source)}`, `Updated: ${new Date(detail.updated_at).toISOString()}`, "", confirmingDelete ? `Delete memory #${detail.id}? Content, embedding and history will be permanently removed.` : "This is the full saved memory, not a search preview."] : [];
        const detailLines = detailText.flatMap((line) => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]);
        detailMaxOffset = Math.max(0, detailLines.length - height);
        detailOffset = Math.min(detailOffset, detailMaxOffset);
        const sqlLines = output.split("\n");
        sqlMaxOffset = Math.max(0, ...sqlLines.map((line) => visibleWidth(line) - width));
        sqlOffset = Math.min(sqlOffset, sqlMaxOffset);
        const outputLines = mode === "sql" && !failed ? sqlLines.map((line) => sliceByColumn(line, sqlOffset, width)) : sqlLines.flatMap((line) => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]);
        outputMaxOffset = Math.max(0, outputLines.length - height);
        outputOffset = Math.min(outputOffset, outputMaxOffset);
        const lines = detail
          ? detailLines.slice(detailOffset, detailOffset + height)
          : output ? outputLines.slice(outputOffset, outputOffset + height).map((line) => failed ? theme.fg("error", line) : mode === "stats" && ["OVERVIEW", "BY SCOPE / KIND", "SEARCH ENGINE"].includes(line) ? color("accent", line) : line)
          : rows.slice(Math.max(0, selected - height + 1), Math.max(0, selected - height + 1) + height).map((row) => color(rows[selected] === row ? "accent" : "text", truncateToWidth(`${rows[selected] === row ? "▸" : " "} #${row.id} [${row.project_id === null ? "global" : "project"}/${safeText(row.kind)}] ${row.similarity === undefined ? "" : `${(row.similarity * 100).toFixed(1)}% `}${safeText(row.content).replace(/\s+/g, " ")}`, width)));
        const modeLabels = modes.map((item) => color(item === mode ? "accent" : "dim", item === mode ? `[${item.toUpperCase()}]` : item.toUpperCase())).join("  ");
        const scopeText = mode === "sql" ? "All projects (read-only SQL)" : scope === "both" ? "Global + current project" : scope === "global" ? "Global only" : "Current project only";
        const header = [modeLabels, theme.fg("dim", `Scope: ${scopeText}`), ""];
        const controls = detail || mode === "stats" ? [] : [color("accent", mode === "list" ? "Filter by kind: note, decision, preference; blank = all" : mode === "sql" ? "Read-only SQL" : mode === "debug" ? "Explain a search · query sent to Google" : "Search memories · query sent to Google"), ...input.render(width), ""];
        const hint = detail ? deleting ? "Deleting…" : confirmingDelete ? "y confirm delete · n / Esc cancel" : "↑↓ scroll · Ctrl+D delete · Esc back" : mode === "stats" ? "Tab/Shift+Tab mode · Ctrl+S scope · Enter refresh · Esc back" : mode === "sql" ? "Tab/Shift+Tab mode · Ctrl+←/→ pan · Enter run · Esc back" : "Tab/Shift+Tab mode · Ctrl+S scope · Enter detail · Esc back";
        return [...header, ...controls, ...diagnostics.split("\n").filter(Boolean).map((line) => theme.fg("dim", line)), ...lines, "", theme.fg(failed || deleteError ? "error" : "dim", detail ? deleteError || (confirmingDelete ? `Permanently delete #${detail.id}, including history?` : "Read saved content or delete this memory") : safeText(status)), theme.fg("dim", hint)].map((line) => truncateToWidth(line, width));
      },
      handleMouse(event: { type: string; button?: string }) {
        if (event.type === "press" && event.button === "left") return { handled: true, focus: true };
      },
      handleInput(data: string) {
        if (deleting) return;
        if (confirmingDelete) {
          if (matchesKey(data, "escape") || data === "n") { confirmingDelete = false; tui.requestRender(); return; }
          if (data !== "y" || !detail) return;
          const id = detail.id;
          deleting = true;
          deleteError = "";
          tui.requestRender();
          void deleteMemory(ctx.cwd, id).then(() => {
            if (closed) return;
            rows = rows.filter((row) => row.id !== id);
            detail = undefined;
            selected = -1;
            diagnostics = "";
            status = `Deleted memory #${id}. ${rows.length} results remaining.`;
          }).catch((error: unknown) => {
            if (!closed) deleteError = safeText(error instanceof Error ? error.message : String(error));
          }).finally(() => {
            deleting = false;
            confirmingDelete = false;
            if (!closed) tui.requestRender();
          });
          return;
        }
        if (matchesKey(data, "escape")) {
          if (detail) { detail = undefined; tui.requestRender(); } else { done(); }
          return;
        }
        if (detail) {
          if (matchesKey(data, "ctrl+d")) { confirmingDelete = true; deleteError = ""; }
          else if (matchesKey(data, "up")) detailOffset = Math.max(0, detailOffset - 1);
          else if (matchesKey(data, "down")) detailOffset = Math.min(detailMaxOffset, detailOffset + 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "tab") || matchesKey(data, "shift+tab") || matchesKey(data, "ctrl+s")) {
          if (!matchesKey(data, "ctrl+s")) {
            mode = modes[(modes.indexOf(mode) + (matchesKey(data, "shift+tab") ? modes.length - 1 : 1)) % modes.length];
            listKind = "";
            const submit = input.onSubmit;
            input = new Input({ prompt: "> ", placeholder: "" });
            input.onSubmit = submit;
          } else {
            if (mode === "sql") return;
            scope = scope === "both" ? "global" : scope === "global" ? "project" : "both";
          }
          page = 0;
          diagnostics = "";
          sequence++;
          rows = [];
          output = "";
          failed = false;
          selected = -1;
          status = mode === "stats" ? "Enter to refresh summary" : mode === "list" ? "Enter to list · optional kind filter · Ctrl+N/P page" : mode === "sql" ? "Enter a read-only SQL query" : "Type a query, then press Enter";
          if (mode === "stats" || mode === "list") input.onSubmit?.(mode === "list" ? listKind : "");
        } else if (mode === "list" && (matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+p"))) {
          page = Math.max(0, page + (matchesKey(data, "ctrl+n") ? 1 : -1));
          selected = -1;
          input.onSubmit?.(listKind);
        } else if (mode === "sql" && matchesKey(data, "ctrl+right")) sqlOffset = Math.min(sqlMaxOffset, sqlOffset + 8);
        else if (mode === "sql" && matchesKey(data, "ctrl+left")) sqlOffset = Math.max(0, sqlOffset - 8);
        else if (output && matchesKey(data, "up")) outputOffset = Math.max(0, outputOffset - 1);
        else if (output && matchesKey(data, "down")) outputOffset = Math.min(outputMaxOffset, outputOffset + 1);
        else if (matchesKey(data, "up")) selected = Math.max(-1, selected - 1);
        else if (matchesKey(data, "down")) selected = Math.min(rows.length - 1, selected + 1);
        else {
          if (mode === "stats") {
            if (matchesKey(data, "return")) input.onSubmit?.("");
            return;
          }
          if (!matchesKey(data, "return")) {
            selected = -1;
            page = 0;
            sequence++;
            if (failed) { failed = false; output = ""; }
            status = mode === "list" ? "Enter to load memories" : mode === "sql" ? "Enter a read-only SQL query" : "Enter to search (sent to Google)";
          }
          input.handleInput(data);
        }
        tui.requestRender();
      },
    };
}

export async function searchPanel(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/memory requires interactive TUI mode", "error"); return; }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => createPanel(ctx, tui, theme, done));
}

export function createMemoryOverlay(ctx: ExtensionContext, tui: TUI, theme: Theme, onOpen: () => void = () => {}) {
  let handle: OverlayHandle | undefined;
  let panel: ReturnType<typeof createPanel> | undefined;
  function close() {
    panel?.dispose();
    panel = undefined;
    handle?.hide();
    handle = undefined;
  }
  function toggle() {
    if (handle) {
      if (handle.isFocused()) close();
      else { handle.focus(); tui.requestRender(); }
      return;
    }
    onOpen();
    if (tui.terminal.columns < 80 || tui.terminal.rows < 12) { void searchPanel(ctx); return; }
    panel = createPanel(ctx, tui, theme, () => handle?.unfocus());
    const content = panel;
    handle = tui.showOverlay({
      get focused() { return content.focused; },
      set focused(value: boolean) { content.focused = value; },
      invalidate() { content.invalidate(); },
      handleInput: content.handleInput,
      handleMouse(event) {
        if ((event.type === "press" || event.type === "click") && event.button === "left") {
          handle?.focus();
          tui.requestRender();
          return { handled: true, focus: true };
        }
        if (event.type === "wheel") { content.handleInput((event.wheelDelta ?? 0) < 0 ? "\x1b[A" : "\x1b[B"); return { handled: true }; }
        return content.handleMouse(event);
      },
      render(width: number) {
        const inner = Math.max(1, width - 2);
        const border = (value: string) => `\x1b[38;2;90;175;255m${value}\x1b[39m`;
        const title = truncateToWidth(" [memory] ", inner);
        return [border("┏" + title + "━".repeat(Math.max(0, inner - visibleWidth(title))) + "┓"), ...content.render(Math.max(1, inner - 2)).map((line) => border("┃") + " " + truncateToWidth(line, Math.max(1, inner - 2), "…", true) + " " + border("┃")), border("┗" + "━".repeat(inner) + "┛")];
      },
    } as Component & Focusable, { anchor: "top-right", width: "65%", minWidth: 36, margin: { top: 1, right: 1 }, visible: (width, height) => width >= 80 && height >= 12, nonCapturing: true });
    handle.focus();
    tui.requestRender();
  }
  return { toggle, close };
}
