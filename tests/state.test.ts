import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as S from "../extensions/task-memory/state/state.ts";
import type * as StateTypes from "../extensions/task-memory/state/state.types.ts";
import { classifyTool, derivePhase, contextLevel, readThresholds } from "../extensions/task-memory/phase/phase.ts";

const NOW = "2026-10-04T10:00:00.000Z";

test("task lifecycle with evidence rules", () => {
  const f: StateTypes.TaskFile = { version: 1, task: null };
  const t = S.startTask(f, { title: "Rate limit", goal: "5/min per IP" }, NOW);
  assert.throws(() => S.startTask(f, { title: "x", goal: "y" }, NOW), S.MemoryError);
  S.planSteps(t, ["a", "b"]);
  S.updateStep(t, 1, "doing");
  assert.throws(() => S.updateStep(t, 2, "doing"), /already in progress/);
  assert.throws(() => S.updateStep(t, 1, "done"), /evidence/);
  const r = S.updateStep(t, 1, "done", "npm test: 3 passed");
  assert.equal(r.nextTodo?.id, 2);
  assert.throws(() => S.finishTask(f, { evidence: "ok tests", docs: "none: internal" }, NOW), /still open/);
  S.updateStep(t, 2, "skipped", "not needed");
  assert.throws(() => S.finishTask(f, { evidence: "npm test ok" }, NOW), /docs/);
  const done = S.finishTask(f, { evidence: "npm test ok", docs: "none: internal" }, NOW);
  assert.equal(done.status, "done");
  assert.equal(f.task, null);
});

test("caps, updates, removes, project upserts", () => {
  const f: StateTypes.TaskFile = { version: 1, task: null };
  const t = S.startTask(f, { title: "T", goal: "G" }, NOW);
  const p = S.emptyProject();
  const trim: StateTypes.Trim = { n: 0 };
  S.applyUpdate(t, p, { decisions: [{ text: "x".repeat(500) }] }, trim);
  assert.equal(trim.n, 1);
  for (let i = 1; i < S.LIMIT.decisions; i++) S.applyUpdate(t, p, { decisions: [{ text: `d${i}` }] });
  assert.throws(() => S.applyUpdate(t, p, { decisions: [{ text: "over" }] }), /Too many/);
  S.applyUpdate(t, p, { remove: ["d1"] });
  assert.equal(t.decisions.length, S.LIMIT.decisions - 1);
  S.applyUpdate(null, p, { project: { verify: [{ name: "test", cmd: "npm t" }] } });
  S.applyUpdate(null, p, { project: { verify: [{ name: "test", cmd: "npm test" }] } });
  assert.deepEqual(p.verify, [{ name: "test", cmd: "npm test" }]);
  assert.throws(() => S.applyUpdate(null, p, { next: "x" }), /No active task/);
});

test("checkpoint + handoff rendering", () => {
  const f: StateTypes.TaskFile = { version: 1, task: null };
  const t = S.startTask(f, { title: "T", goal: "G" }, NOW);
  S.planSteps(t, ["one", "two"]);
  assert.throws(() => S.checkpoint(t, { next: "" }, NOW, {}), /next/);
  S.checkpoint(t, {
    next: "edit auth.ts",
    readNow: [{ path: "src/auth.ts", lines: "L40-90", reason: "limiter goes here" }],
    readLater: [{ path: "docs/api.md", reason: "document 429", step: 2 }],
    known: [{ path: "src/config.ts", fact: "exports RATE_LIMIT" }],
  }, NOW, { head: "abc123", dirty: ["src/auth.ts"] });
  const h = S.renderHandoff(t, S.emptyProject());
  for (const s of ["Handoff · checkpoint 1", "HEAD abc123", "Read now", "Read later", "Known, no need to re-read", "Next action: edit auth.ts"]) assert.ok(h.includes(s), s);
  assert.equal(S.readLaterFor(t, 2).length, 1);
  assert.match(S.statusLine(t), /step 0\/2/);
});

test("persistence roundtrip + gitignore + bad json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-"));
  const f: StateTypes.TaskFile = { version: 1, task: null };
  S.startTask(f, { title: "T", goal: "G" }, NOW);
  S.saveTaskFile(dir, f);
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "*\n");
  assert.equal(S.loadTaskFile(dir).task?.title, "T");
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ decisions: null, map: [{ path: "a", purpose: "b" }] }));
  assert.deepEqual(S.loadProject(dir).decisions, []);
  assert.equal(S.loadProject(dir).map.length, 1);
  fs.writeFileSync(path.join(dir, "project.json"), "{bad");
  assert.throws(() => S.loadProject(dir), S.MemoryError);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("phase + thresholds", () => {
  assert.equal(classifyTool("bash", { command: "npm test" }), "verify");
  assert.equal(classifyTool("bash", { command: "ls -la" }), "read");
  assert.equal(classifyTool("bash", { command: "cat test.txt | grep build" }), "read");
  assert.equal(classifyTool("bash", { command: "cd app && npm test" }), "verify");
  assert.equal(classifyTool("bash", { command: "sed -i 's/a/b/' x.ts" }), "edit");
  assert.equal(classifyTool("bash", { command: "node script.js" }), "other");
  assert.equal(classifyTool("edit", {}), "edit");
  assert.equal(classifyTool("task", { action: "checkpoint" }), "checkpoint");
  const base = { running: true, compacting: false, handoff: false, resuming: false, active: [], hasTask: true, stepDoing: false };
  assert.equal(derivePhase({ ...base, running: false }), "idle");
  assert.equal(derivePhase({ ...base, active: ["edit", "read"] }), "coding");
  assert.equal(derivePhase({ ...base, compacting: true }), "compacting");
  assert.equal(derivePhase(base), "planning");
  const th = readThresholds({});
  assert.deepEqual(th, { warn: 50, must: 75 });
  assert.equal(contextLevel(55, th), "warn");
  assert.equal(contextLevel(75, th), "must");
  assert.equal(contextLevel(52, th, 48), "ok");
  assert.equal(contextLevel(23, { warn: 20, must: 23 }), "must");
  assert.equal(contextLevel(99, th, 80), "must");
  assert.deepEqual(readThresholds({ TASK_MEMORY_WARN_PCT: "20", TASK_MEMORY_MUST_PCT: "65" }), { warn: 20, must: 65 });
  assert.deepEqual(readThresholds({ TASK_MEMORY_WARN_PCT: "99", TASK_MEMORY_MUST_PCT: "20" }), th);
  assert.equal(contextLevel(null, th), "unknown");
});

test("one-off handoff without a task", () => {
  const cp = S.buildCheckpoint(1, { next: "answer user", readNow: [{ path: "a.ts", reason: "r" }] }, NOW, {});
  const h = S.renderHandoff(null, S.emptyProject(), { checkpoint: cp });
  for (const s of ["No active task (one-off session)", "Next action: answer user", "Read now", "- a.ts: r"]) assert.ok(h.includes(s), s);
});

test("checkpoint caps; seq only advances when valid; start never auto-abandons", () => {
  const f: StateTypes.TaskFile = { version: 1, task: null };
  const t = S.startTask(f, { title: "T", goal: "G" }, NOW);
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, reason: "r" }));
  assert.throws(() => S.checkpoint(t, { next: "x", readNow: many }, NOW, {}), /max 8/);
  assert.equal(S.checkpoint(t, { next: "x" }, NOW, {}).seq, 1);
  assert.throws(() => S.startTask(f, { title: "B", goal: "G" }, NOW), /ask the user/);
});

test("inferAction fills a missing action only when unambiguous", () => {
  assert.equal(S.inferAction({ next: "x", readNow: [] }).action, "checkpoint");
  assert.equal(S.inferAction({ id: "2", status: "done" }).action, "step");
  assert.equal(S.inferAction({ id: "2", status: "done" }).id, 2);
  assert.equal(S.inferAction({ title: "t", goal: "g", steps: ["a"] }).action, "start");
  assert.equal(S.inferAction({ next: "x" }).action, undefined);
  assert.equal(S.inferAction({ action: "show", docs: "x" }).action, "show");
});
