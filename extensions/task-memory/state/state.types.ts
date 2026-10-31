export type StepStatus = "todo" | "doing" | "done" | "skipped";

export interface Step {
  id: number;
  text: string;
  status: StepStatus;
  evidence?: string;
}

export interface Item {
  id: number;
  text: string;
  why?: string;
}

export interface Issue {
  id: number;
  text: string;
  resolved?: string;
}

export interface FileRef {
  path: string;
  lines?: string;
  reason: string;
  step?: number;
}

export interface Known {
  path: string;
  fact: string;
}

export interface GitInfo {
  branch?: string;
  head?: string;
  dirty?: string[];
}

export interface Checkpoint extends GitInfo {
  seq: number;
  at: string;
  next: string;
  readNow: FileRef[];
  readLater: FileRef[];
  known: Known[];
  context?: string;
}

export interface TaskOutcome {
  at: string;
  evidence?: string;
  docs?: string;
  reason?: string;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  constraints?: string;
  status: "active" | "done" | "abandoned";
  createdAt: string;
  updatedAt: string;
  steps: Step[];
  stepSeq: number;
  decisions: Item[];
  issues: Issue[];
  notes: Item[];
  next?: string;
  checkpoint?: Checkpoint;
  checkpointSeq: number;
  outcome?: TaskOutcome;
}

export interface TaskFile {
  version: 1;
  task: Task | null;
}

export interface ProjectVerification {
  name: string;
  cmd: string;
}

export interface ProjectMapEntry {
  path: string;
  purpose: string;
}

export interface Project {
  version: 1;
  decisions: Item[];
  conventions: Item[];
  notes: Item[];
  verify: ProjectVerification[];
  map: ProjectMapEntry[];
}

export interface Trim { n: number }

export interface StartTaskInput {
  title?: string;
  goal?: string;
  constraints?: string;
}

export interface StepUpdateResult {
  step: Step;
  nextTodo?: Step;
}

export interface DecisionInput {
  text: string;
  why?: string;
}

export interface IssueResolution {
  id: number;
  resolution: string;
}

export interface ProjectUpdateInput {
  decisions?: DecisionInput[];
  conventions?: string[];
  notes?: string[];
  verify?: ProjectVerification[];
  map?: ProjectMapEntry[];
}

export interface UpdateInput {
  next?: string;
  decisions?: DecisionInput[];
  issues?: string[];
  resolve?: IssueResolution[];
  notes?: string[];
  remove?: string[]; // ids like d2, i1, n3, pd1, pc2, pn1, pv:test, pm:src/x.ts
  project?: ProjectUpdateInput;
}

export interface CheckpointInput {
  next: string; readNow?: FileRef[]; readLater?: FileRef[]; known?: Known[]; context?: string;
}

export interface FinishTaskInput {
  evidence?: string;
  docs?: string;
  abandon?: boolean;
  reason?: string;
}

export interface HandoffRenderOptions {
  auto?: boolean;
  touched?: string[];
  now?: string;
  checkpoint?: Checkpoint;
}

export type Json = Record<string, unknown>;
