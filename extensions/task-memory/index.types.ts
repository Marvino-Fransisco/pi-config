import type { ToolKind } from "./phase/phase.types.ts";

export interface Saved {
  summary: string;
  hash: string;
  seq: number;
}

export interface PendingInjection {
  content: string;
  hash: string;
}

export interface ActiveTool {
  kind: ToolKind;
  args: unknown;
}
