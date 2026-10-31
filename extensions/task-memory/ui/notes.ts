import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

export function createNotes(tui: TUI, theme: Theme, readText: () => string, reportError: (message: string) => void, readContext: (width: number) => string = () => "Context panel is unavailable.") {
  let handle: OverlayHandle | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let text = "";
  let lastError = "";
  let offset = 0;
  let maxOffset = 0;
  let tab: "task" | "context" = "task";
  let contextWidth = 0;

  function refresh(width = Math.max(1, Math.floor(tui.terminal.columns * 0.65) - 4)): void {
    try {
      const next = tab === "task" ? readText() : readContext(width);
      if (tab === "context") contextWidth = width;
      lastError = "";
      if (next !== text) {
        text = next;
        tui.requestRender();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) reportError(`task-memory: ${message}`);
      lastError = message;
    }
  }

  function close(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    handle?.hide();
    handle = undefined;
    offset = 0;
  }

  function toggle(next: "task" | "context" = "task"): void {
    if (handle && (next === "task" || tab === next)) {
      close();
      return;
    }
    open(next);
  }

  function open(next: "task" | "context"): void {
    tab = next;
    offset = 0;
    refresh();
    if (handle) { focus(); tui.requestRender(); return; }
    handle = tui.showOverlay({
      invalidate() {},
      render(width: number): string[] {
        const inner = Math.max(1, width - 2);
        if (tab === "context" && inner !== contextWidth) refresh(inner);
        const height = Math.max(1, Math.min(16, tui.terminal.rows - 6));
        const lines = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, inner));
        maxOffset = Math.max(0, lines.length - height);
        offset = Math.min(offset, maxOffset);
        const title = truncateToWidth(tab === "task" ? " [task] · context " : " task · [context] ", inner);
        const border = (value: string) => `\x1b[38;2;90;175;255m${value}\x1b[39m`;
        const row = (value: string) => border("┃") + truncateToWidth(value, inner, "…", true) + border("┃");
        const hint = handle?.isFocused() ? " ←→ tab · ↑↓ scroll · Esc " : " click or Ctrl+Option+T focus ";
        return [
          border(`┏${title}${"━".repeat(Math.max(0, inner - visibleWidth(title)))}┓`),
          ...lines.slice(offset, offset + height).map(row),
          row(theme.fg("dim", hint)),
          border(`┗${"━".repeat(inner)}┛`),
        ];
      },
      handleMouse(event) {
        if (event.type === "press" && event.button === "left") {
          return { handled: true, focus: true };
        }
        if (event.type === "wheel") {
          offset = Math.max(0, Math.min(maxOffset, offset + (event.wheelDelta ?? 0)));
          return { handled: true };
        }
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape")) {
          handle?.unfocus();
        } else if (matchesKey(data, "left") || matchesKey(data, "right") || data === "h" || data === "l") {
          tab = tab === "task" ? "context" : "task";
          offset = 0;
          refresh();
        } else if (matchesKey(data, "up") || data === "k") {
          offset = Math.max(0, offset - 1);
        } else if (matchesKey(data, "down") || data === "j") {
          offset = Math.min(maxOffset, offset + 1);
        } else if (matchesKey(data, "pageUp")) {
          offset = Math.max(0, offset - 10);
        } else if (matchesKey(data, "pageDown")) {
          offset = Math.min(maxOffset, offset + 10);
        }
        tui.requestRender();
      },
    }, {
      anchor: "top-right",
      width: "65%",
      minWidth: 36,
      margin: { top: 1, right: 1 },
      visible: (width, height) => width >= 80 && height >= 12,
      nonCapturing: true,
    });
    focus();
    timer = setInterval(() => { if (tab === "task") refresh(); }, 1000);
    timer.unref();
  }

  function canShow(): boolean {
    return tui.terminal.columns >= 80 && tui.terminal.rows >= 12;
  }

  function focus(): boolean {
    if (!handle || !canShow()) return false;
    handle.focus();
    tui.requestRender();
    return true;
  }

  return { toggle, open, focus, close, canShow };
}
