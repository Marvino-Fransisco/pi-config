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

function animatePhase(text: string, frame: number): string {
  return [...text].map((char, index) => {
    const wave = (Math.sin(frame * 0.12 - index * 0.45) + 1) / 2;
    return `\x1b[38;2;${Math.round(45 + wave * 80)};${Math.round(125 + wave * 75)};255m${char}`;
  }).join("") + "\x1b[39m";
}

export function installWidget(
  ctx: ExtensionContext,
  getState: () => WidgetState,
  setRerender: (callback: (() => void) | undefined) => void,
  onReady: (tui: TUI, theme: Theme) => void,
): void {
  ctx.ui.setWidget("task-memory", (tui, theme) => {
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      const { phase } = getState();
      const active = phase.running || phase.compacting || phase.resuming;
      if (active && !timer) {
        timer = setInterval(() => { frame++; tui.requestRender(); }, 120);
        timer.unref();
      }
      if (!active && timer) { clearInterval(timer); timer = undefined; }
      tui.requestRender();
    };
    setRerender(refresh);
    onReady(tui, theme);
    refresh();
    return {
      dispose() { if (timer) clearInterval(timer); setRerender(undefined); },
      invalidate() {},
      render(width: number): string[] {
        const { task, phase: input, percent, thresholds, baseline } = getState();
        const phase = derivePhase({
          ...input,
          hasTask: task !== null,
          stepDoing: task?.steps.some((s) => s.status === "doing") ?? false,
        });

        const label = `${PHASE_ICON[phase]} ${phase}`;
        const head = phase === "idle" ? theme.fg(PHASE_COLOR[phase], label) : animatePhase(label, frame);
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
