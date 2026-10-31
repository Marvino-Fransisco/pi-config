import type { PhaseInput, Thresholds } from "../phase/phase.types.ts";
import type { Task } from "../state/state.types.ts";

export interface WidgetState {
  task: Task | null;
  phase: Omit<PhaseInput, "hasTask" | "stepDoing">;
  percent: number | null;
  thresholds: Thresholds;
  baseline?: number;
}
