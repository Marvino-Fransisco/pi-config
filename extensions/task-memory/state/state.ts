// Pure data model + rules + rendering + persistence. No Pi imports (testable with plain node).
import * as fs from "node:fs";
import * as path from "node:path";
import type { StepStatus, Step, Item, Issue, FileRef, Known, GitInfo, Checkpoint, TaskOutcome, Task, TaskFile, ProjectVerification, ProjectMapEntry, Project, Trim, StartTaskInput, StepUpdateResult, DecisionInput, IssueResolution, ProjectUpdateInput, UpdateInput, CheckpointInput, FinishTaskInput, HandoffRenderOptions, Json } from "./state.types.ts";

export const LIMIT = {
  title: 80, goal: 400, constraints: 300, step: 160, evidence: 240, text: 200, why: 200,
  openSteps: 15, totalSteps: 40, decisions: 12, openIssues: 8, notes: 10,
  readNow: 8, readLater: 12, known: 15, context: 1200,
  pDecisions: 20, pConventions: 15, pNotes: 10, pVerify: 8, pMap: 30,
};

export class MemoryError extends Error {}

export function clip(s: unknown, max: number, t?: Trim): string {
  const v = String(s ?? "").replace(/\s+/g, " ").trim();
  if (v.length <= max) return v;
  if (t) t.n++;
  return v.slice(0, max - 1) + "…";
}

function clipBlock(s: unknown, max: number, t?: Trim): string {
  const v = String(s ?? "").trim();
  if (v.length <= max) return v;
  if (t) t.n++;
  return v.slice(0, max - 1) + "…";
}

const nextId = (l: { id: number }[]) => l.reduce((m, x) => Math.max(m, x.id), 0) + 1;

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}

// ---------------------------------------------------------------- mutations

export function startTask(file: TaskFile, p: StartTaskInput, now: string, t?: Trim): Task {
  if (file.task?.status === "active")
    throw new MemoryError(`Task "${file.task.title}" is already active. If the request belongs to it, continue it. Otherwise ask the user before abandoning it (finish abandon:true reason); never abandon on your own.`);
  const title = clip(p.title, LIMIT.title, t);
  const goal = clip(p.goal, LIMIT.goal, t);
  if (!title || !goal) throw new MemoryError("start needs title and goal.");
  const task: Task = {
    id: `${now.slice(0, 10)}-${slug(title)}`, title, goal,
    constraints: p.constraints ? clip(p.constraints, LIMIT.constraints, t) : undefined,
    status: "active", createdAt: now, updatedAt: now,
    steps: [], stepSeq: 0, decisions: [], issues: [], notes: [], checkpointSeq: 0,
  };
  file.task = task;
  return task;
}

export function requireActive(file: TaskFile): Task {
  if (!file.task || file.task.status !== "active")
    throw new MemoryError("No active task. Call task with action:start (title, goal) first.");
  return file.task;
}

export function planSteps(task: Task, texts: string[], mode: "replace" | "append" = "replace", t?: Trim): Step[] {
  const clean = (texts ?? []).map((s) => clip(s, LIMIT.step, t)).filter(Boolean);
  if (clean.length === 0) throw new MemoryError("plan needs at least one step.");
  const kept = mode === "replace" ? task.steps.filter((s) => s.status !== "todo") : task.steps;
  const added = clean.map((text) => ({ id: ++task.stepSeq, text, status: "todo" as StepStatus }));
  const steps = [...kept, ...added];
  const open = steps.filter((s) => s.status === "todo" || s.status === "doing").length;
  if (open > LIMIT.openSteps) throw new MemoryError(`Too many open steps (${open} > ${LIMIT.openSteps}). Use fewer, larger steps.`);
  if (steps.length > LIMIT.totalSteps) throw new MemoryError(`Task has too many steps (${steps.length}). Finish it and start a follow-up task.`);
  task.steps = steps;
  return added;
}

export function updateStep(task: Task, id: number, status: StepStatus, evidence?: string, t?: Trim): StepUpdateResult {
  const step = task.steps.find((s) => s.id === id);
  if (!step) throw new MemoryError(`No step ${id}. Steps: ${task.steps.map((s) => s.id).join(", ") || "none"}.`);
  if (status === "doing") {
    const other = task.steps.find((s) => s.status === "doing" && s.id !== id);
    if (other) throw new MemoryError(`Step ${other.id} is already in progress. Finish and verify it (done/skipped) before starting another.`);
  }
  const ev = clip(evidence, LIMIT.evidence, t);
  if (status === "done" && ev.length < 3)
    throw new MemoryError("done needs evidence: the verification you ran and its result (e.g. 'npm test: 42 passed'), or 'manual: <reason>'.");
  if (status === "skipped" && ev.length < 3) throw new MemoryError("skipped needs a reason in evidence.");
  step.status = status;
  if (ev) step.evidence = ev; else delete step.evidence;
  return { step, nextTodo: task.steps.find((s) => s.status === "todo") };
}

export function readLaterFor(task: Task, stepId: number): FileRef[] {
  return (task.checkpoint?.readLater ?? []).filter((f) => f.step === stepId);
}

export function applyUpdate(task: Task | null, project: Project, u: UpdateInput, t?: Trim): string[] {
  const out: string[] = [];
  const needsTask = u.next || u.decisions?.length || u.issues?.length || u.resolve?.length || u.notes?.length ||
    (u.remove ?? []).some((r) => /^[din]\d/.test(r));
  if (needsTask && (!task || task.status !== "active"))
    throw new MemoryError("No active task for task-level update. Use project.* for durable knowledge, or start a task.");

  for (const r of u.remove ?? []) out.push(removeId(task, project, r));

  if (task) {
    if (u.next) { task.next = clip(u.next, LIMIT.text, t); out.push("next set"); }
    for (const d of u.decisions ?? []) {
      if (task.decisions.length >= LIMIT.decisions)
        throw new MemoryError(`Too many task decisions (${LIMIT.decisions}). Remove/merge some or promote to project.decisions.`);
      const id = nextId(task.decisions);
      task.decisions.push({ id, text: clip(d.text, LIMIT.text, t), why: d.why ? clip(d.why, LIMIT.why, t) : undefined });
      out.push(`d${id}`);
    }
    for (const s of u.issues ?? []) {
      if (task.issues.filter((i) => !i.resolved).length >= LIMIT.openIssues)
        throw new MemoryError(`Too many open issues (${LIMIT.openIssues}). Resolve or remove some.`);
      const id = nextId(task.issues);
      task.issues.push({ id, text: clip(s, LIMIT.text, t) });
      out.push(`i${id}`);
    }
    for (const r of u.resolve ?? []) {
      const i = task.issues.find((x) => x.id === r.id);
      if (!i || i.resolved) throw new MemoryError(`No open issue i${r.id}.`);
      i.resolved = clip(r.resolution || "resolved", LIMIT.text, t);
      out.push(`i${r.id} resolved`);
    }
    const resolved = task.issues.filter((i) => i.resolved);
    if (resolved.length > 5) {
      const drop = new Set(resolved.slice(0, resolved.length - 5).map((i) => i.id));
      task.issues = task.issues.filter((i) => !drop.has(i.id));
    }
    for (const s of u.notes ?? []) {
      if (task.notes.length >= LIMIT.notes) throw new MemoryError(`Too many notes (${LIMIT.notes}). Remove some first.`);
      const id = nextId(task.notes);
      task.notes.push({ id, text: clip(s, LIMIT.text, t) });
      out.push(`n${id}`);
    }
  }

  const p = u.project;
  if (p) {
    const add = (list: Item[], cap: number, label: string, prefix: string, text: string, why?: string) => {
      if (list.length >= cap) throw new MemoryError(`Too many project ${label} (${cap}). Remove/merge some first.`);
      const id = nextId(list);
      list.push({ id, text: clip(text, LIMIT.text, t), why: why ? clip(why, LIMIT.why, t) : undefined });
      out.push(`${prefix}${id}`);
    };
    for (const d of p.decisions ?? []) add(project.decisions, LIMIT.pDecisions, "decisions", "pd", d.text, d.why);
    for (const c of p.conventions ?? []) add(project.conventions, LIMIT.pConventions, "conventions", "pc", c);
    for (const n of p.notes ?? []) add(project.notes, LIMIT.pNotes, "notes", "pn", n);
    for (const v of p.verify ?? []) {
      const name = clip(v.name, 40, t), cmd = clip(v.cmd, LIMIT.text, t);
      const ex = project.verify.find((x) => x.name === name);
      if (ex) ex.cmd = cmd;
      else { if (project.verify.length >= LIMIT.pVerify) throw new MemoryError("Too many verify commands."); project.verify.push({ name, cmd }); }
      out.push(`pv:${name}`);
    }
    for (const m of p.map ?? []) {
      const pth = clip(m.path, 160, t), purpose = clip(m.purpose, LIMIT.text, t);
      const ex = project.map.find((x) => x.path === pth);
      if (ex) ex.purpose = purpose;
      else { if (project.map.length >= LIMIT.pMap) throw new MemoryError("Project map full. Remove entries (pm:<path>) first."); project.map.push({ path: pth, purpose }); }
      out.push(`pm:${pth}`);
    }
  }
  if (out.length === 0) throw new MemoryError("update had nothing to apply.");
  return out;
}

function removeId(task: Task | null, project: Project, r: string): string {
  if (r.startsWith("pv:")) { project.verify = project.verify.filter((v) => v.name !== r.slice(3)); return `removed ${r}`; }
  if (r.startsWith("pm:")) { project.map = project.map.filter((v) => v.path !== r.slice(3)); return `removed ${r}`; }
  const m = /^(pd|pc|pn|d|i|n)(\d+)$/.exec(r);
  if (!m) throw new MemoryError(`Bad id "${r}". Use d2, i1, n3, pd1, pc2, pn1, pv:<name>, pm:<path>.`);
  const lists: Record<string, { id: number }[] | undefined> = {
    d: task?.decisions, i: task?.issues, n: task?.notes,
    pd: project.decisions, pc: project.conventions, pn: project.notes,
  };
  const list = lists[m[1]!];
  const idx = list ? list.findIndex((x) => x.id === Number(m[2])) : -1;
  if (!list || idx < 0) throw new MemoryError(`No entry ${r}.`);
  list.splice(idx, 1);
  return `removed ${r}`;
}

export function buildCheckpoint(seq: number, c: CheckpointInput, now: string, git: GitInfo, t?: Trim): Checkpoint {
  const next = clip(c.next, LIMIT.text, t);
  if (!next) throw new MemoryError("checkpoint needs next: the concrete next action.");
  const refs = (l: FileRef[] | undefined, cap: number, name: string) => {
    const v = l ?? [];
    if (v.length > cap) throw new MemoryError(`${name} has ${v.length} entries (max ${cap}). Keep only what matters.`);
    return v.map((f) => ({
      path: clip(f.path, 160, t), lines: f.lines ? clip(f.lines, 30, t) : undefined,
      reason: clip(f.reason, 160, t), step: typeof f.step === "number" ? f.step : undefined,
    }));
  };
  const known = c.known ?? [];
  if (known.length > LIMIT.known) throw new MemoryError(`known has ${known.length} entries (max ${LIMIT.known}).`);
  const cp: Checkpoint = {
    seq, at: now, next,
    readNow: refs(c.readNow, LIMIT.readNow, "readNow"),
    readLater: refs(c.readLater, LIMIT.readLater, "readLater"),
    known: known.map((k) => ({ path: clip(k.path, 160, t), fact: clip(k.fact, 160, t) })),
    context: c.context ? clipBlock(c.context, LIMIT.context, t) : undefined,
    branch: git.branch, head: git.head, dirty: git.dirty,
  };
  return cp;
}

/** Validates first; the sequence only advances when the checkpoint is valid. */
export function checkpoint(task: Task, c: CheckpointInput, now: string, git: GitInfo, t?: Trim): Checkpoint {
  const cp = buildCheckpoint(task.checkpointSeq + 1, c, now, git, t);
  task.checkpointSeq = cp.seq;
  task.checkpoint = cp;
  task.next = cp.next;
  return cp;
}

export function finishTask(file: TaskFile, p: FinishTaskInput, now: string, t?: Trim): Task {
  const task = requireActive(file);
  if (p.abandon) {
    const reason = clip(p.reason || p.evidence, LIMIT.text, t);
    if (!reason) throw new MemoryError("abandon needs a reason.");
    task.status = "abandoned";
    task.outcome = { at: now, reason };
  } else {
    const open = task.steps.filter((s) => s.status === "todo" || s.status === "doing");
    if (open.length) throw new MemoryError(`Steps still open: ${open.map((s) => s.id).join(", ")}. Mark them done/skipped, or abandon.`);
    const evidence = clip(p.evidence, LIMIT.evidence, t);
    if (evidence.length < 3) throw new MemoryError("finish needs evidence of a final verification run.");
    const docs = clip(p.docs, LIMIT.text, t);
    if (!docs) throw new MemoryError("finish needs docs: user-facing docs you updated, or 'none: <reason>'. Never put agent notes in user docs.");
    task.status = "done";
    task.outcome = { at: now, evidence, docs };
  }
  task.updatedAt = now;
  file.task = null;
  return task;
}

// ---------------------------------------------------------------- rendering

const MARK: Record<StepStatus, string> = { done: "[x]", skipped: "[-]", doing: "[>]", todo: "[ ]" };

function renderSteps(task: Task): string[] {
  const closed = task.steps.filter((s) => s.status === "done" || s.status === "skipped");
  const collapse = closed.length > 3 ? new Set(closed.slice(0, closed.length - 3).map((s) => s.id)) : new Set<number>();
  const lines: string[] = [];
  if (collapse.size) lines.push(`- ${collapse.size} earlier steps closed (${[...collapse].join(", ")})`);
  for (const s of task.steps) {
    if (collapse.has(s.id)) continue;
    const tail = s.status === "doing" ? " (in progress)" : s.evidence ? ` — ${s.status === "done" ? "verified" : "skipped"}: ${s.evidence}` : "";
    lines.push(`- ${MARK[s.status]} ${s.id} ${s.text}${tail}`);
  }
  return lines;
}

function taskBody(task: Task): string[] {
  const L: string[] = [`Task: ${task.title}`, `Goal: ${task.goal}`];
  if (task.constraints) L.push(`Constraints: ${task.constraints}`);
  if (task.steps.length) L.push("Progress", ...renderSteps(task));
  if (task.decisions.length) L.push("Decisions (don't revisit without new evidence)", ...task.decisions.map((d) => `- d${d.id} ${d.text}${d.why ? `: ${d.why}` : ""}`));
  const open = task.issues.filter((i) => !i.resolved);
  if (open.length) L.push("Open issues", ...open.map((i) => `- i${i.id} ${i.text}`));
  if (task.notes.length) L.push("Notes", ...task.notes.map((n) => `- n${n.id} ${n.text}`));
  if (task.next) L.push(`Next action: ${task.next}`);
  return L;
}

const ref = (f: FileRef) => `- ${f.path}${f.lines ? ` ${f.lines}` : ""}${f.step ? ` (step ${f.step})` : ""}: ${f.reason}`;

function fileSections(cp: Checkpoint | undefined): string[] {
  if (!cp) return [];
  const L: string[] = [];
  if (cp.context) L.push("Critical context", cp.context);
  if (cp.readNow.length) L.push("Read now", ...cp.readNow.map(ref));
  if (cp.readLater.length) L.push("Read later", ...cp.readLater.map(ref));
  if (cp.known.length) L.push("Known, no need to re-read", ...cp.known.map((k) => `- ${k.path}: ${k.fact}`));
  return L;
}

export function renderProject(p: Project): string {
  const L: string[] = [];
  if (p.decisions.length) L.push("Decisions (settled)", ...p.decisions.map((d) => `- pd${d.id} ${d.text}${d.why ? `: ${d.why}` : ""}`));
  if (p.conventions.length) L.push("Conventions", ...p.conventions.map((c) => `- pc${c.id} ${c.text}`));
  if (p.verify.length) L.push("Verify commands", ...p.verify.map((v) => `- ${v.name}: \`${v.cmd}\``));
  if (p.map.length) L.push("Key paths", ...p.map.map((m) => `- ${m.path}: ${m.purpose}`));
  if (p.notes.length) L.push("Notes", ...p.notes.map((n) => `- pn${n.id} ${n.text}`));
  return L.length ? ["## Project memory (check before re-exploring the repo)", ...L].join("\n") : "";
}

export function renderTask(task: Task | null): string {
  if (!task) return "";
  return ["## Active task", ...taskBody(task), ...fileSections(task.checkpoint)].join("\n");
}

export function renderHandoff(
  task: Task | null, project: Project,
  opts: HandoffRenderOptions = {},
): string {
  const cp = opts.checkpoint ?? task?.checkpoint;
  const head = opts.auto
    ? `## Handoff (automatic, ${opts.now ?? ""}) — agent did not write one in time; file lists may be stale`
    : `## Handoff · checkpoint ${cp?.seq ?? "?"} · ${cp?.at ?? ""}${cp?.head ? ` · HEAD ${cp.head}` : ""}${cp?.dirty?.length ? ` · dirty: ${cp.dirty.join(", ")}` : ""}`;
  const L: string[] = [
    head,
    "This handoff replaces the earlier conversation and is the source of truth.",
    "Resume: re-read ONLY the \"Read now\" items (targeted lines), then do \"Next action\". Read \"Read later\" files only when their step starts.",
    "Use \"Known\" facts and recorded decisions instead of re-reading, but re-check a Known fact before reporting it as a final result or editing based on it. If the user's latest request is already answered, stop and wait.",
    "",
  ];
  if (task) L.push(...taskBody(task), ...fileSections(cp));
  else {
    L.push("No active task (one-off session).");
    if (cp) L.push(`Next action: ${cp.next}`, ...fileSections(cp));
  }
  if (opts.touched?.length) L.push("Files touched since the last compaction (unclassified)", ...opts.touched.map((s) => `- ${s}`));
  const pm = renderProject(project);
  if (pm) L.push("", pm);
  return L.join("\n");
}

export function statusLine(task: Task | null): string {
  if (!task) return "no active task";
  const closed = task.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const doing = task.steps.find((s) => s.status === "doing");
  const todo = task.steps.find((s) => s.status === "todo");
  const parts = [task.title];
  if (task.steps.length) parts.push(`step ${closed}/${task.steps.length}`);
  if (doing) parts.push(`doing: ${doing.text}`);
  else if (task.next) parts.push(`next: ${task.next}`);
  else if (todo) parts.push(`next: ${todo.text}`);
  return parts.join(" · ");
}

export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
export function stateHash(task: Task | null, project: Project): string {
  return hash(JSON.stringify({ task, project }));
}

// ---------------------------------------------------------------- tool input

/** Fill in a missing `action` when the other fields make it unambiguous (small models sometimes drop it). */
export function inferAction(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const a: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (typeof a.id === "string" && /^\d+$/.test(a.id)) a.id = Number(a.id);
  if (typeof a.action === "string") return a;
  const has = (...keys: string[]) => keys.some((k) => a[k] !== undefined);
  const rules: Array<[string, boolean]> = [
    ["checkpoint", has("readNow", "readLater", "known", "context", "compact")],
    ["finish", has("docs", "abandon")],
    ["step", a.id !== undefined && a.status !== undefined],
    ["update", has("decisions", "issues", "resolve", "notes", "remove", "project")],
    ["start", a.title !== undefined && a.goal !== undefined],
    ["plan", has("steps")],
  ];
  const hit = rules.find(([, ok]) => ok);
  if (hit) a.action = hit[0];
  return a;
}

// ---------------------------------------------------------------- persistence

export const emptyProject = (): Project => ({ version: 1, decisions: [], conventions: [], notes: [], verify: [], map: [] });

function readJson(file: string): Json | undefined {
  if (!fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as Json; }
  catch (e) { throw new MemoryError(`${file} is not valid JSON (${(e as Error).message}). Fix or delete it.`); }
}

export function loadTaskFile(dir: string): TaskFile {
  // SAFETY: task.json is only written by saveTaskFile; missing arrays are normalized below.
  const v = readJson(path.join(dir, "task.json")) as unknown as TaskFile | undefined;
  if (!v) return { version: 1, task: null };
  if (v.task) {
    const t = v.task as Task;
    t.steps ??= []; t.decisions ??= []; t.issues ??= []; t.notes ??= [];
    t.stepSeq ??= t.steps.reduce((m, s) => Math.max(m, s.id), 0);
    t.checkpointSeq ??= t.checkpoint?.seq ?? 0;
  }
  return { version: 1, task: v.task ?? null };
}

export function loadProject(dir: string): Project {
  // SAFETY: project.json is only written by saveProject; merged over emptyProject() defaults.
  const v = readJson(path.join(dir, "project.json")) as unknown as Partial<Project> | undefined;
  const list = <T>(items: T[] | undefined): T[] => (Array.isArray(items) ? items : []);
  return {
    version: 1,
    decisions: list(v?.decisions), conventions: list(v?.conventions), notes: list(v?.notes),
    verify: list(v?.verify), map: list(v?.map),
  };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(path.join(dir, "archive"), { recursive: true });
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function loadThresholdSettings(dir: string): Json | undefined { return readJson(path.join(dir, "thresholds.json")); }
export function saveThresholdSettings(dir: string, settings: { warn: number; must: number }): void { ensureDir(dir); writeAtomic(path.join(dir, "thresholds.json"), settings); }

export function saveTaskFile(dir: string, f: TaskFile): void { ensureDir(dir); writeAtomic(path.join(dir, "task.json"), f); }
export function saveProject(dir: string, p: Project): void { ensureDir(dir); writeAtomic(path.join(dir, "project.json"), p); }
export function archiveTask(dir: string, task: Task): string {
  ensureDir(dir);
  let file = path.join(dir, "archive", `${task.id}.json`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, "archive", `${task.id}-${i}.json`);
  writeAtomic(file, task);
  return file;
}
