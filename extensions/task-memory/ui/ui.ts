import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
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
  onReady: (tui: TUI, theme: Theme) => void,
): void {
  ctx.ui.setWidget("task-memory", (tui, theme) => {
    setRerender(() => tui.requestRender());
    onReady(tui, theme);
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
