// task-memory: durable task state, agent-written handoffs at compaction, phase widget.
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as S from "./state/state.ts";
import type * as StateTypes from "./state/state.types.ts";
import { classifyTool, contextLevel, readThresholds } from "./phase/phase.ts";
import type { ToolKind, Thresholds } from "./phase/phase.types.ts";
import * as P from "./prompts/prompts.ts";
import { Params } from "./schema/schema.ts";
import type { TaskParams } from "./schema/schema.types.ts";
import { applyTaskAction } from "./actions/actions.ts";
import type { Handoff } from "./actions/actions.types.ts";
import type { Saved, PendingInjection, ActiveTool } from "./index.types.ts";
import { compactionDraft, lastKnownHash } from "./compaction/compaction.ts";
import { installWidget } from "./ui/ui.ts";
import { createNotes } from "./ui/notes.ts";

const LABELS: Record<string, string> = {
  "task-memory-warn": "context high: handoff at the next step boundary",
  "task-memory-must": "MANDATORY handoff requested (context limit)",
  "task-memory-handoff": "handoff requested before compaction",
  "task-memory-sync": "progress sync requested",
};

export default function (pi: ExtensionAPI) {
  // ---- runtime state (reset on session_start)
  let cwd = process.cwd();
  let root = cwd;
  let dir = path.join(root, ".pi", "memory");
  let th: Thresholds = readThresholds(process.env);
  let ctxRef: ExtensionContext | undefined;
  let rerender: (() => void) | undefined;
  let notes: ReturnType<typeof createNotes> | undefined;
  let cachedTask: StateTypes.Task | null = null;
  let pendingInject: PendingInjection | undefined;

  let running = false;
  let compacting = false;
  let resuming = false;
  const active = new Map<string, ActiveTool>();
  let lastKind: ToolKind | undefined;
  const touched = new Map<string, "read" | "edit">();
  const runEdited = new Set<string>();
  let editSeq = 0;
  let syncedSeq = 0;
  let syncSent = false;
  let taskEngaged = false;

  let handoff: Handoff = "none";
  let terminateAfter = false;
  let warned = false;
  let settleAsked = false;
  let mustTurns = 0;
  let baseline: number | undefined;
  let needBaseline = false;
  let fresh: Saved | undefined;      // checkpoint saved without compaction, still current
  let compactNow: Saved | undefined; // checkpoint that asked for compaction at turn_end
  let lastCompactFromUs = false;
  let scratchSeq = 0;

  const now = () => new Date().toISOString();
  const safeTask = () => { try { return S.loadTaskFile(dir).task; } catch { return null; } };
  const safeProject = () => { try { return S.loadProject(dir); } catch { return S.emptyProject(); } };
  const render = () => rerender?.();
  const notify = (m: string, t: "info" | "warning" | "error" = "info") => { if (ctxRef?.hasUI) ctxRef.ui.notify(m, t); };
  const msg = (customType: string, content: string): SessionBoundaryDraft =>
    ({ type: "custom_message", customType, content, display: true });

  const stateText = (task: StateTypes.Task | null, project: StateTypes.Project) =>
    [S.renderTask(task), S.renderProject(project)].filter(Boolean).join("\n\n");

  function injectText(task: StateTypes.Task | null, project: StateTypes.Project, taskPrefix: string): string {
    const parts: string[] = [];
    const pm = S.renderProject(project);
    if (pm) parts.push(`${P.PROJECT_PREFIX}\n\n${pm}`);
    if (task) parts.push(`${taskPrefix}\n\n${S.renderTask(task)}`);
    return parts.join("\n\n");
  }

  function touchedList(): string[] {
    return [...touched.entries()]
      .sort((a, b) => (a[1] === b[1] ? 0 : a[1] === "edit" ? -1 : 1))
      .slice(0, 30)
      .map(([p, k]) => `${p} (${k === "edit" ? "edited" : "read"})`);
  }
  const touchedText = () => touchedList().map((s) => `- ${s}`).join("\n");

  function pct(ctx: ExtensionContext): number | null {
    const p = ctx.getContextUsage()?.percent;
    return typeof p === "number" ? p : null;
  }
  function level(ctx: ExtensionContext) {
    const p = pct(ctx);
    if (needBaseline && p !== null) { baseline = p; needBaseline = false; }
    return { p, lvl: contextLevel(p, th, baseline) };
  }

  function newSegment(): void {
    handoff = "none";
    terminateAfter = false;
    warned = false;
    mustTurns = 0;
    fresh = undefined;
    compactNow = undefined;
    touched.clear();
    baseline = undefined;
    needBaseline = true;
    resuming = true;
  }

  function resetAll(): void {
    running = compacting = resuming = false;
    active.clear();
    touched.clear();
    runEdited.clear();
    lastKind = undefined;
    editSeq = syncedSeq = 0;
    syncSent = taskEngaged = settleAsked = false;
    handoff = "none";
    terminateAfter = false;
    warned = false;
    mustTurns = 0;
    baseline = undefined;
    needBaseline = false;
    fresh = undefined;
    compactNow = undefined;
    lastCompactFromUs = false;
    pendingInject = undefined;
    scratchSeq = 0;
  }

  function findRoot(start: string): string {
    let d = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(d, ".git"))) return d;
      const up = path.dirname(d);
      if (up === d) return path.resolve(start);
      d = up;
    }
  }

  async function gitInfo(): Promise<StateTypes.GitInfo> {
    try {
      const h = await pi.exec("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
      const s = await pi.exec("git", ["-C", root, "status", "--porcelain"]);
      const dirty = s.code === 0
        ? s.stdout.split("\n").map((l) => l.slice(3).trim()).filter((f) => f && !f.startsWith(".pi/memory")).slice(0, 15)
        : undefined;
      return { head: h.code === 0 ? h.stdout.trim() : undefined, dirty };
    } catch { return {}; }
  }

  function fallbackDraft(ctx: ExtensionContext): SessionBoundaryDraft {
    const task = safeTask(), project = safeProject();
    const summary = S.renderHandoff(task, project, { auto: true, now: now(), touched: touchedList() });
    const draft = compactionDraft(pi, ctx, summary, { auto: true, hash: S.stateHash(task, project) });
    notify("task-memory: no handoff was written in time; compacted with an automatic one", "warning");
    newSegment(); compacting = true; render();
    return draft;
  }

  function refreshInject(ctx: ExtensionContext): void {
    const task = safeTask(), project = safeProject();
    cachedTask = task;
    const h = S.stateHash(task, project);
    const content = injectText(task, project, P.RESUME_PREFIX);
    pendingInject = content && lastKnownHash(ctx) !== h ? { content, hash: h } : undefined;
  }

  function trackFiles(args: unknown, kind: "edit" | "read"): void {
    const mem = path.join(".pi", "memory");
    for (const raw of argPaths(args)) {
      if (/^[a-z]+:\/\//i.test(raw)) continue;
      const abs = path.resolve(cwd, raw);
      let rel = path.relative(root, abs);
      if (rel.startsWith("..")) rel = abs;
      if (!rel || isDir(abs)) continue; // repo root itself, or a directory from ls/find/grep
      if (rel === mem || rel.startsWith(mem + path.sep)) continue;
      if (kind === "edit") { touched.set(rel, "edit"); runEdited.add(rel); editSeq++; }
      else if (!touched.has(rel)) touched.set(rel, "read");
    }
  }

  // ---------------------------------------------------------------- session
  pi.on("session_start", async (_e, ctx) => {
    ctxRef = ctx;
    resetAll();
    cwd = ctx.cwd;
    root = findRoot(ctx.cwd);
    dir = path.join(root, ".pi", "memory");
    th = readThresholds(process.env);
    try { S.loadTaskFile(dir); S.loadProject(dir); }
    catch (err) { notify(`task-memory: ${(err as Error).message}`, "error"); }
    refreshInject(ctx);
    if (cachedTask) notify(`task-memory: active task — ${S.statusLine(cachedTask)}. Say "continue" or /task resume.`);
    if (ctx.mode === "tui") installWidget(ctx, () => ({
      task: cachedTask = safeTask(),
      phase: {
        running, compacting, resuming,
        handoff: handoff === "must" || handoff === "settle" || handoff === "manual",
        active: [...active.values()].map((a) => a.kind), last: lastKind,
      },
      percent: ctxRef ? pct(ctxRef) : null,
      thresholds: th, baseline,
    }), (callback) => { rerender = callback; }, (tui, theme) => {
      notes?.close();
      notes = createNotes(tui, theme, () => {
        const task = S.loadTaskFile(dir).task;
        const project = S.loadProject(dir);
        return stateText(task, project) || "No active task and no project memory.";
      }, (message) => notify(message, "error"));
    });
  });

  pi.on("session_tree", async (_e, ctx) => {
    ctxRef = ctx;
    handoff = "none"; terminateAfter = false; warned = false; mustTurns = 0;
    fresh = undefined; compactNow = undefined; baseline = undefined; needBaseline = false;
    refreshInject(ctx); render();
  });

  pi.on("session_shutdown", async () => { notes?.close(); notes = undefined; rerender = undefined; });

  pi.on("before_agent_start", async () => {
    if (!pendingInject) return;
    const inj = pendingInject; pendingInject = undefined;
    return { message: { customType: "task-memory-state", content: inj.content, display: false, details: { hash: inj.hash } } };
  });

  pi.on("agent_start", async () => { running = true; render(); });
  pi.on("turn_start", async () => { if (compacting) { compacting = false; render(); } });
  pi.on("agent_settled", async () => {
    running = false; resuming = false; compacting = false;
    active.clear(); runEdited.clear(); syncSent = false; settleAsked = false;
    if (handoff === "settle") handoff = "boundary"; // ignored: ask again at the next boundary
    else if (handoff === "manual") handoff = "none";
    terminateAfter = false;
    render();
  });

  // ---------------------------------------------------------------- tool tracking
  pi.on("tool_execution_start", async (e) => {
    if (e.parentToolCallId) return;
    active.set(e.toolCallId, { kind: classifyTool(e.toolName, e.args), args: e.args });
    render();
  });

  pi.on("tool_execution_end", async (e) => {
    if (e.parentToolCallId) return;
    const a = active.get(e.toolCallId); active.delete(e.toolCallId);
    const kind = a?.kind ?? classifyTool(e.toolName, undefined);
    lastKind = kind;
    if (e.toolName === "task") taskEngaged = true; else fresh = undefined;
    if (!e.isError) {
      if (kind === "edit" || kind === "verify") resuming = false;
      if (kind === "edit" || kind === "read") trackFiles(a?.args, kind);
    }
    render();
  });

  pi.on("tool_call", async (e) => {
    if (handoff !== "must" || e.toolName === "task") return;
    return { block: true, reason: "task-memory: context limit reached. Write the handoff first (task action:checkpoint). Other tools are blocked." };
  });

  // ---------------------------------------------------------------- boundaries
  pi.on("turn_end", async (e, ctx) => {
    ctxRef = ctx;
    if (compactNow) {
      const c = compactNow;
      const draft = compactionDraft(pi, ctx, c.summary, { hash: c.hash, checkpoint: c.seq });
      newSegment(); compacting = true;
      notify(`task-memory: compacted using handoff #${c.seq}`);
      render();
      return { entries: [...e.entries, draft] };
    }
    if (e.outcome !== "completed") return;
    const ending = e.toolResults.length === 0;

    if (handoff === "must") {
      if (++mustTurns >= 3) return { entries: [...e.entries, fallbackDraft(ctx)] };
      return;
    }
    const { p, lvl } = level(ctx);
    if (lvl === "must" && p !== null) {
      if (ending && !ctx.hasUI) return { entries: [...e.entries, fallbackDraft(ctx)] }; // headless: never add a turn after the final answer
      const alreadyAsked = handoff === "settle" || handoff === "manual";
      handoff = "must"; mustTurns = 0;
      if (ending) terminateAfter = true;
      notify(`task-memory: context ${p.toFixed(0)}% — mandatory handoff`, "error"); render();
      if (alreadyAsked) return;
      return { entries: [...e.entries, msg("task-memory-must", P.MUST_MSG(p, touchedText(), cachedTask !== null))], continue: true };
    }
    if (lvl === "warn" && p !== null && !warned) {
      warned = true;
      if (handoff === "none") handoff = "boundary";
      notify(`task-memory: context ${p.toFixed(0)}% — handoff at the next step boundary`, "warning"); render();
      if (!ending) return { entries: [...e.entries, msg("task-memory-warn", P.WARN_MSG(p, touchedText(), cachedTask !== null))] };
    }
  });

  pi.on("agent_before_settle", async (e, ctx) => {
    ctxRef = ctx;
    if (e.outcome !== "completed") return;
    if (handoff === "must" || handoff === "manual") return { entries: [...e.entries, fallbackDraft(ctx)] }; // required handoff not written: use an automatic one
    const { p, lvl } = level(ctx);
    // Headless (print/json): an extra turn would replace the printed answer, so only a required compaction happens.
    if (!ctx.hasUI) return lvl === "must" ? { entries: [...e.entries, fallbackDraft(ctx)] } : undefined;
    if (!settleAsked && (handoff === "boundary" || lvl === "warn" || lvl === "must")) {
      settleAsked = true; warned = true; handoff = "settle"; terminateAfter = true; render();
      return { entries: [...e.entries, msg("task-memory-handoff", P.SETTLE_MSG(p, touchedText(), cachedTask !== null))], continue: true };
    }
    if (taskEngaged && cachedTask && editSeq > syncedSeq && !syncSent && runEdited.size) {
      syncSent = true;
      return { entries: [...e.entries, msg("task-memory-sync", P.SYNC_MSG([...runEdited]))], continue: true };
    }
  });

  pi.on("session_before_compact", async (e, ctx) => {
    if (fresh) {
      const f = fresh;
      lastCompactFromUs = true; compacting = true; render();
      return { compaction: {
        summary: f.summary,
        firstKeptEntryId: e.preparation.firstKeptEntryId,
        tokensBefore: e.preparation.tokensBefore,
        details: { source: "task-memory", hash: f.hash, checkpoint: f.seq },
      } };
    }
    if (e.reason === "manual" && !running && ctx.hasUI) {
      handoff = "manual"; terminateAfter = true; render();
      const content = P.MANUAL_MSG(e.customInstructions ?? "", touchedText(), cachedTask !== null);
      notify("task-memory: the agent writes a handoff first, then compacts");
      setTimeout(() => pi.sendMessage({ customType: "task-memory-handoff", content, display: true }, { triggerTurn: true }), 50);
      return { cancel: true };
    }
    lastCompactFromUs = false; compacting = true; render();
    return undefined;
  });

  pi.on("session_compact", async () => {
    const ours = lastCompactFromUs; lastCompactFromUs = false;
    newSegment(); compacting = false; render();
    if (ours) return;
    const task = safeTask(), project = safeProject();
    const content = injectText(task, project, P.POST_COMPACT_PREFIX);
    if (!content) return;
    pi.sendMessage(
      { customType: "task-memory-state", content, display: false, details: { hash: S.stateHash(task, project) } },
      { deliverAs: running ? "steer" : "nextTurn" },
    );
  });

  pi.on("session_compact_failed", async () => { compacting = false; lastCompactFromUs = false; render(); });

  // ---------------------------------------------------------------- tool
  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Durable task memory. Actions: start(title, goal, constraints?, steps?), plan(steps, mode?), step(id, status, evidence?), " +
      "update(next?, decisions?, issues?, resolve?, notes?, remove?, project?), " +
      "checkpoint(next, readNow?, readLater?, known?, context?, compact?; add title+goal to create a task if none is active), " +
      "finish(evidence, docs | abandon, reason), show.",
    promptSnippet: P.SNIPPET,
    promptGuidelines: P.GUIDELINES,
    parameters: Params,
    // Small models sometimes drop `action`; fill it in when the other fields make it unambiguous.
    prepareArguments: (args) => S.inferAction(args) as TaskParams,
    async execute(_id, p, _signal, _onUpdate, ctx) {
      ctxRef = ctx; taskEngaged = true;
      const t: StateTypes.Trim = { n: 0 };
      const ts = now();
      const git = p.action === "checkpoint" ? await gitInfo() : {};
      const file = S.loadTaskFile(dir);
      const project = S.loadProject(dir);
      const result = applyTaskAction({ p, file, project, ts, t, git, dir, root, scratchSeq, handoff, terminateAfter });
      let { text } = result;
      const { changed, saveProject, terminate, ck } = result;
      scratchSeq = result.scratchSeq;

      if (changed) {
        if (file.task) file.task.updatedAt = ts;
        S.saveTaskFile(dir, file);
        cachedTask = file.task;
      }
      if (saveProject) S.saveProject(dir, project);
      const h = S.stateHash(file.task, project);
      if (ck?.compact) { compactNow = { summary: ck.summary, hash: h, seq: ck.seq }; compacting = true; }
      else if (ck) fresh = { summary: ck.summary, hash: h, seq: ck.seq };
      if (p.action !== "show") syncedSeq = editSeq;
      if (t.n) text += `\n(trimmed ${t.n} long field${t.n > 1 ? "s" : ""}; keep memory terse)`;
      render();
      return { content: [{ type: "text", text }], details: { hash: h, action: p.action }, terminate };
    },
    renderCall(args, theme) {
      const extra = args.title ?? (args.id !== undefined ? `#${args.id} ${args.status ?? ""}` : args.next ?? "");
      return new Text(theme.fg("toolTitle", theme.bold("task ")) + theme.fg("muted", `${args.action} ${String(extra).slice(0, 80)}`), 0, 0);
    },
    renderResult(result, _o, theme) {
      const c = result.content[0];
      const first = c && c.type === "text" ? c.text.split("\n")[0] ?? "" : "";
      return new Text(theme.fg("dim", first), 0, 0);
    },
  });

  for (const [type, label] of Object.entries(LABELS)) {
    pi.registerMessageRenderer(type, (_m, _o, theme) =>
      new Text(theme.fg(type === "task-memory-must" ? "error" : "warning", `task-memory: ${label}`), 0, 0));
  }

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Focus task notes for scrolling",
    handler: async (ctx) => {
      if (!notes?.focus()) ctx.ui.notify("Open /task and use a terminal at least 80 columns by 12 rows.", "info");
    },
  });

  // ---------------------------------------------------------------- command
  pi.registerCommand("task", {
    description: "Show task memory. /task resume | /task abandon",
    getArgumentCompletions: (prefix: string) =>
      ["resume", "abandon"].flatMap((s) => (s.startsWith(prefix) ? [{ value: s, label: s }] : [])),
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const sub = args.trim();
      const task = safeTask(), project = safeProject();

      if (sub === "resume") {
        if (!task) { ctx.ui.notify("No active task.", "info"); return; }
        pendingInject = undefined; taskEngaged = true;
        const opt = ctx.isIdle() ? undefined : { deliverAs: "followUp" as const };
        pi.sendMessage({
          customType: "task-memory-state", content: injectText(task, project, P.RESUME_PREFIX),
          display: false, details: { hash: S.stateHash(task, project) },
        }, opt);
        pi.sendUserMessage("Continue the active task from its saved state.", opt);
        return;
      }

      if (sub === "abandon") {
        if (!task) { ctx.ui.notify("No active task.", "info"); return; }
        if (ctx.hasUI && !(await ctx.ui.confirm("Abandon task?", task.title))) return;
        const file = S.loadTaskFile(dir);
        const done = S.finishTask(file, { abandon: true, reason: "abandoned by user" }, now());
        S.archiveTask(dir, done); S.saveTaskFile(dir, file);
        cachedTask = null; pendingInject = undefined; render();
        pi.sendMessage({
          customType: "task-memory-state", content: `[task-memory] The user abandoned task "${done.title}". Ignore its saved state.`,
          display: false, details: { hash: S.stateHash(null, project) },
        }, ctx.isIdle() ? undefined : { deliverAs: "nextTurn" });
        ctx.ui.notify(`Abandoned "${done.title}" (archived).`, "info");
        return;
      }

      const text = stateText(task, project) || "No active task and no project memory.";
      if (ctx.mode !== "tui") { ctx.ui.notify(text, "info"); return; }
      notes?.toggle();
    },
  });
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function argPaths(args: unknown): string[] {
  const a = (args ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["path", "file_path", "filePath", "file"]) if (typeof a[k] === "string") out.push(a[k] as string);
  if (Array.isArray(a.paths)) for (const p of a.paths) if (typeof p === "string") out.push(p);
  return out;
}
