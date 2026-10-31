import type * as S from "../state/state.types.ts";
import type { TaskParams } from "../schema/schema.types.ts";

export type Handoff = "none" | "boundary" | "settle" | "must" | "manual";

export interface ActionCheckpoint {
  summary: string;
  seq: number;
  compact: boolean;
}

export interface TaskActionInput {
  p: TaskParams;
  file: S.TaskFile;
  project: S.Project;
  ts: string;
  t: S.Trim;
  git: S.GitInfo;
  dir: string;
  root: string;
  scratchSeq: number;
  handoff: Handoff;
  terminateAfter: boolean;
}

export interface TaskActionResult {
  text: string;
  changed: boolean;
  saveProject: boolean;
  terminate: boolean;
  ck: ActionCheckpoint | undefined;
  scratchSeq: number;
}
