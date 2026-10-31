export const SNIPPET =
  "durable task memory: plan, progress, decisions and handoffs that survive compaction and new sessions";

export const GUIDELINES = [
  "Chat context is temporary; the `task` tool is the durable record. For multi-step work (several steps or files), call task start + plan before editing. Skip it for one-off questions and small edits.",
  "Work one step at a time: step doing -> implement -> verify -> step done with evidence (command + result, or 'manual: <reason>'). Never mark a step done without verifying it.",
  "Record as you go, tersely (facts, not narrative): decisions with why, blockers as issues, and durable repo knowledge via update project.* (decisions, conventions, verify commands, key paths).",
  "Check project memory and recorded decisions before re-exploring the repo or reconsidering a settled choice.",
  "Handoffs (task checkpoint): next = the concrete next action; readNow = only what that action needs, with line ranges; readLater = files for later steps (tag step); known = one-line facts copied from tool output (never from memory) so a file needs no re-read.",
  "Finish with a final verification (re-check any value carried over from a handoff), then task finish (evidence + docs). Update README/CHANGELOG only if user-visible behavior changed; never put agent notes in user docs.",
];

const FILES = (touched: string): string =>
  touched
    ? `\nFiles touched since the last compaction (classify the relevant ones):\n${touched}`
    : "";

const HOW = (hasTask: boolean): string =>
  'Call the task tool with action "checkpoint" and: next, readNow, readLater, known (facts copied from tool output), context (exact errors/values that must survive). ' +
  (hasTask
    ? "Carry forward still-relevant items from the previous handoff."
    : "No task is active: omit title/goal (the handoff then lives only in the compacted context) unless unfinished multi-step work remains that must survive into later sessions.");

export const WARN_MSG = (pct: number, touched: string, hasTask: boolean): string =>
  `[task-memory] Context is at ${pct.toFixed(0)}%. Finish and verify the current step, then write a handoff before starting the next step. ${HOW(hasTask)} Set compact:true.${FILES(touched)}`;

export const MUST_MSG = (pct: number, touched: string, hasTask: boolean): string =>
  `[task-memory] MANDATORY: context is at ${pct.toFixed(0)}%. Stop now. Your next call must be the handoff; other tools are blocked until it is written. ${HOW(hasTask)}${FILES(touched)}`;

export const SETTLE_MSG = (
  pct: number | null,
  touched: string,
  hasTask: boolean,
): string =>
  `[task-memory] Context is at ${pct === null ? "a high level" : `${pct.toFixed(0)}%`}. Before stopping, write a handoff so the context can be compacted. ${HOW(hasTask)} Do not do any other work.${FILES(touched)}`;

export const MANUAL_MSG = (focus: string, touched: string, hasTask: boolean): string =>
  `[task-memory] The user ran /compact. Write a handoff first. ${HOW(hasTask)}${focus ? `\nFocus requested by the user: ${focus}` : ""} Do not do any other work.${FILES(touched)}`;

export const SYNC_MSG = (files: string[]): string =>
  `[task-memory] You changed files (${files.slice(0, 10).join(", ")}) but did not update the active task. Record progress now with the task tool (step status + evidence, decisions, issues, next) in one batch, then reply with one short line.`;

export const PROJECT_PREFIX =
  "[task-memory] Project memory (.pi/memory/project.json): durable knowledge about this repo. Use it instead of re-exploring; it applies to any request here.";

export const RESUME_PREFIX =
  '[task-memory] Saved task from an earlier session. Continue it only if the user\'s request relates to it or they say continue/resume; otherwise ignore it. When resuming, re-read only the "Read now" items, then do the next action.';

export const POST_COMPACT_PREFIX =
  "[task-memory] Context was compacted by Pi's default summarizer. Saved task state may be stale; reconcile it with the summary and recent messages before continuing. Write a fresh handoff (task checkpoint) at the next step boundary.";
