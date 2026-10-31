import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const FileRef = Type.Object({
  path: Type.String(),
  lines: Type.Optional(Type.String({ description: "e.g. L40-90" })),
  reason: Type.String(),
  step: Type.Optional(Type.Number({ description: "step id this file is needed for (readLater)" })),
});

export const Params = Type.Object({
  action: StringEnum(["start", "plan", "step", "update", "checkpoint", "finish", "show"] as const),
  title: Type.Optional(Type.String()),
  goal: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(Type.String(), { description: "plan/start: step texts" })),
  mode: Type.Optional(StringEnum(["replace", "append"] as const)),
  id: Type.Optional(Type.Number({ description: "step id" })),
  status: Type.Optional(StringEnum(["todo", "doing", "done", "skipped"] as const)),
  evidence: Type.Optional(Type.String({ description: "verification command + result, or 'manual: <reason>'" })),
  next: Type.Optional(Type.String({ description: "concrete next action" })),
  decisions: Type.Optional(Type.Array(Type.Object({
    text: Type.String(),
    why: Type.Optional(Type.String()),
  }))),
  issues: Type.Optional(Type.Array(Type.String())),
  resolve: Type.Optional(Type.Array(Type.Object({
    id: Type.Number(),
    resolution: Type.String(),
  }))),
  notes: Type.Optional(Type.Array(Type.String())),
  remove: Type.Optional(Type.Array(Type.String({ description: "d2, i1, n3, pd1, pc2, pn1, pv:<name>, pm:<path>" }))),
  project: Type.Optional(Type.Object({
    decisions: Type.Optional(Type.Array(Type.Object({
      text: Type.String(),
      why: Type.Optional(Type.String()),
    }))),
    conventions: Type.Optional(Type.Array(Type.String())),
    notes: Type.Optional(Type.Array(Type.String())),
    verify: Type.Optional(Type.Array(Type.Object({
      name: Type.String(),
      cmd: Type.String(),
    }))),
    map: Type.Optional(Type.Array(Type.Object({
      path: Type.String(),
      purpose: Type.String(),
    }))),
  })),
  readNow: Type.Optional(Type.Array(FileRef)),
  readLater: Type.Optional(Type.Array(FileRef)),
  known: Type.Optional(Type.Array(Type.Object({ path: Type.String(), fact: Type.String() }))),
  context: Type.Optional(Type.String({ description: "checkpoint: exact errors/values that must survive compaction" })),
  compact: Type.Optional(Type.Boolean({ description: "checkpoint: compact the context right after saving" })),
  docs: Type.Optional(Type.String({ description: "finish: user docs updated, or 'none: <reason>'" })),
  abandon: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String()),
});

