export type Phase = "idle" | "thinking" | "planning" | "exploring" | "coding" | "verifying" | "handoff" | "compacting" | "resuming";

export type ToolKind = "edit" | "read" | "verify" | "web" | "task" | "checkpoint" | "other";

export interface ToolArguments {
  action?: unknown;
  command?: unknown;
}

export interface PhaseInput {
  running: boolean;
  compacting: boolean;
  handoff: boolean;
  resuming: boolean;
  active: ToolKind[];
  last?: ToolKind;
  hasTask: boolean;
  stepDoing: boolean;
}

export type Level = "ok" | "warn" | "must" | "unknown";

export interface Thresholds {
  warn: number;
  must: number;
}
