import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

export function createNotes(tui: TUI, theme: Theme, readText: (width: number) => string, reportError: (message: string) => void, title = "task", onOpen: () => void = () => {}) {
  let handle: OverlayHandle | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let text = "";
  let lastError = "";
  let offset = 0;
  let maxOffset = 0;
  let contentWidth = 0;

  function refresh(width = Math.max(1, Math.floor(tui.terminal.columns * 0.65) - 4)): void {
    try {
      const next = readText(width);
      contentWidth = width;
      lastError = "";
      if (next !== text) { text = next; tui.requestRender(); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) reportError(`${title}: ${message}`);
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

  function open(): void {
    if (handle) { focus(); return; }
    onOpen();
    refresh();
    handle = tui.showOverlay({
      invalidate() { contentWidth = 0; },
      render(width: number): string[] {
        const inner = Math.max(1, width - 2);
        const textWidth = Math.max(1, inner - 2);
        if (textWidth !== contentWidth) refresh(textWidth);
        const height = Math.max(1, Math.min(16, tui.terminal.rows - 6));
        const lines = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, textWidth));
        maxOffset = Math.max(0, lines.length - height);
        offset = Math.min(offset, maxOffset);
        const heading = truncateToWidth(` [${title}] `, inner);
        const border = (value: string) => `\x1b[38;2;90;175;255m${value}\x1b[39m`;
        const row = (value: string) => border("┃") + " " + truncateToWidth(value, textWidth, "…", true) + " " + border("┃");
        return [
          border(`┏${heading}${"━".repeat(Math.max(0, inner - visibleWidth(heading)))}┓`),
          row(""),
          ...lines.slice(offset, offset + height).map(row),
          row(""),
          row(theme.fg("dim", handle?.isFocused() ? " ↑↓ scroll · Esc close " : ` /${title} to close `)),
          border(`┗${"━".repeat(inner)}┛`),
        ];
      },
      handleMouse(event) {
        if ((event.type === "press" || event.type === "click") && event.button === "left") {
          focus();
          return { handled: true, focus: true };
        }
        if (event.type === "wheel") {
          offset = Math.max(0, Math.min(maxOffset, offset + (event.wheelDelta ?? 0)));
          return { handled: true };
        }
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape")) close();
        else if (matchesKey(data, "up") || data === "k") offset = Math.max(0, offset - 1);
        else if (matchesKey(data, "down") || data === "j") offset = Math.min(maxOffset, offset + 1);
        else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - 10);
        else if (matchesKey(data, "pageDown")) offset = Math.min(maxOffset, offset + 10);
        tui.requestRender();
      },
    }, {
      anchor: "top-right", width: "65%", minWidth: 36, margin: { top: 1, right: 1 },
      visible: (width, height) => width >= 80 && height >= 12, nonCapturing: true,
    });
    focus();
    timer = setInterval(() => refresh(contentWidth), 1000);
    timer.unref();
  }

  function canShow(): boolean { return tui.terminal.columns >= 80 && tui.terminal.rows >= 12; }
  function focus(): boolean {
    if (!handle || !canShow()) return false;
    handle.focus();
    tui.requestRender();
    return true;
  }
  function toggle(): void { if (handle) close(); else open(); }
  return { toggle, open, focus, close, canShow };
}
