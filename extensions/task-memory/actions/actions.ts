import * as path from "node:path";
import * as S from "../state/state.ts";
import type * as StateTypes from "../state/state.types.ts";
import type { ActionCheckpoint, TaskActionInput, TaskActionResult } from "./actions.types.ts";

const refText = (f: StateTypes.FileRef): string =>
  `${f.path}${f.lines ? ` ${f.lines}` : ""} (${f.reason})`;

export function applyTaskAction(input: TaskActionInput): TaskActionResult {
  const {
    p,
    file,
    project,
    ts,
    t,
    git,
    dir,
    root,
    scratchSeq,
    handoff,
    terminateAfter,
  } = input;

  let text: string = "";
  let changed: boolean = false;
  let saveProject: boolean = false;
  let terminate: boolean = false;
  let nextScratchSeq: number = scratchSeq;
  let ck: ActionCheckpoint | undefined;

  switch (p.action) {
    case "show": {
      text =
        [S.renderTask(file.task), S.renderProject(project)]
          .filter(Boolean)
          .join("\n\n") || "No active task and no project memory.";
      break;
    }

    case "start": {
      const task = S.startTask(file, p, ts, t);

      if (p.steps?.length) S.planSteps(task, p.steps, "replace", t);

      text = `Started "${task.title}".${task.steps.length ? `\n${S.renderTask(task)}` : " Next: task plan."}`;
      changed = true;
      break;
    }

    case "plan": {
      const task = S.requireActive(file);
      S.planSteps(task, p.steps ?? [], p.mode ?? "replace", t);

      text = task.steps
        .map((s) => `${s.id}. [${s.status}] ${s.text}`)
        .join("\n");
      changed = true;
      break;
    }

    case "step": {
      const task = S.requireActive(file);

      if (p.id === undefined || !p.status) {
        throw new S.MemoryError("step needs id and status.");
      }

      const r = S.updateStep(task, p.id, p.status, p.evidence, t);
      text = `Step ${r.step.id} -> ${r.step.status}.`;

      if (r.step.status === "doing") {
        const later = S.readLaterFor(task, r.step.id);
        if (later.length)
          text += `\nFiles flagged for this step: ${later.map(refText).join("; ")}`;
      }

      if (r.step.status === "done") {
        if (r.nextTodo) {
          const later = S.readLaterFor(task, r.nextTodo.id);
          text += ` Next step: ${r.nextTodo.id} ${r.nextTodo.text}.${later.length ? ` Files flagged for it: ${later.map(refText).join("; ")}.` : ""}`;
        } else
          text +=
            " All steps closed: run a final verification, then task finish.";
        if (handoff === "boundary")
          text +=
            " Context is high: write the handoff now (task checkpoint compact:true) before starting the next step.";
      }

      changed = true;
      break;
    }

    case "update": {
      const out = S.applyUpdate(file.task, project, p as StateTypes.UpdateInput, t);
      saveProject = p.project !== undefined || (p.remove ?? []).some((r) => r.startsWith("p"));
      changed = file.task !== null;
      text = `Updated: ${out.join(", ")}`;
      break;
    }

    case "checkpoint": {
      if (!file.task && (p.title || p.goal)) {
        S.startTask(
          file,
          {
            title: p.title || S.clip(p.goal, 60),
            goal: p.goal || p.title,
            constraints: p.constraints,
          },
          ts,
          t,
        );
      }

      const input: StateTypes.CheckpointInput = {
        next: p.next ?? "",
        readNow: p.readNow,
        readLater: p.readLater,
        known: p.known,
        context: p.context,
      };

      const task = file.task;
      const cp = task
        ? S.checkpoint(task, input, ts, git, t)
        : S.buildCheckpoint(scratchSeq + 1, input, ts, git, t);

      if (!task) nextScratchSeq = cp.seq;

      changed = task !== null;
      ck = {
        summary: S.renderHandoff(task, project, { checkpoint: cp }),
        seq: cp.seq,
        compact: p.compact === true || handoff !== "none",
      };

      if (ck.compact) {
        terminate = terminateAfter;
        text = terminate
          ? `Handoff #${cp.seq} saved. Context will be compacted. Stop now and wait for the user.`
          : `Handoff #${cp.seq} saved. Context will be compacted; then re-read only the "Read now" items and continue: ${cp.next}`;
      } else {
        text = `Checkpoint #${cp.seq} saved (no compaction). Next: ${cp.next}`;
      }

      if (!task)
        text +=
          " (No active task: this handoff lives only in the compacted context. Include title + goal for multi-step work.)";
      break;
    }

    case "finish": {
      const task = S.finishTask(file, p, ts, t);
      const where = S.archiveTask(dir, task);
      text = `Task ${task.status}; archived to ${path.relative(root, where)}. Tell the user what changed${task.outcome?.docs ? ` (docs: ${task.outcome.docs})` : ""}.`;
      changed = true;
      break;
    }
  }

  return {
    text,
    changed,
    saveProject,
    terminate,
    ck,
    scratchSeq: nextScratchSeq,
  };
}
