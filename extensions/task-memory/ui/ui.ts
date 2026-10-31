import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { contextLevel, derivePhase, PHASE_ICON } from "../phase/phase.ts";
import type { Phase } from "../phase/phase.types.ts";
import type { WidgetState } from "./ui.types.ts";
import { statusLine } from "../state/state.ts";

const PHASE_COLOR: Record<Phase, ThemeColor> = {
  idle: "dim", thinking: "muted", planning: "accent", exploring: "accent", coding: "success",
  verifying: "warning", handoff: "warning", compacting: "warning", resuming: "accent",
};

export function installWidget(
  ctx: ExtensionContext,
  getState: () => WidgetState,
  setRerender: (callback: (() => void) | undefined) => void,
): void {
  ctx.ui.setWidget("task-memory", (tui, theme) => {
    setRerender(() => tui.requestRender());
    return {
      dispose() { setRerender(undefined); },
      invalidate() {},
      render(width: number): string[] {
        const { task, phase: input, percent, thresholds, baseline } = getState();
        const phase = derivePhase({
          ...input,
          hasTask: task !== null,
          stepDoing: task?.steps.some((s) => s.status === "doing") ?? false,
        });

        const head = theme.fg(PHASE_COLOR[phase], `${PHASE_ICON[phase]} ${phase}`);
        const lines = [truncateToWidth(`${head}${theme.fg("muted", ` · ${statusLine(task)}`)}`, width, "…")];
        const lvl = contextLevel(percent, thresholds, baseline);

        if (percent !== null && lvl === "must") {
          lines.push(truncateToWidth(`\x1b[1;97;41m !! CONTEXT ${percent.toFixed(0)}% — MUST HANDOFF + COMPACT NOW !! \x1b[0m`, width, "…"));
        } else if (percent !== null && lvl === "warn") {
          lines.push(truncateToWidth(theme.fg("warning", `⚠ context ${percent.toFixed(0)}% — handoff + compact at the next step boundary`), width, "…"));
        }
        return lines;
      },
    };
  }, { placement: "belowEditor" });
}

export async function showTaskPanel(ctx: ExtensionContext, cwd: string, dir: string, text: string): Promise<void> {
  await ctx.ui.custom<void>((_tui, theme, _kb, done) => ({
    render(width: number) {
      const title = `── task-memory (${path.relative(cwd, dir) || dir}) `;
      return [
        theme.fg("accent", truncateToWidth(title + "─".repeat(Math.max(0, width - visibleWidth(title))), width, "…")),
        "",
        ...text.split("\n").map((l) => truncateToWidth(l, width, "…")),
        "",
        theme.fg("dim", "Esc / q / Enter to close"),
        theme.fg("accent", "─".repeat(Math.max(0, width))),
      ];
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || data === "q") done();
    },
  }));
}
