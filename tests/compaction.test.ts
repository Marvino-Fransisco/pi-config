import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionDraft, lastKnownHash } from "../extensions/task-memory/compaction/compaction.ts";

test("compaction draft retains the selected tail and identifies its source", () => {
  const branch = [{ type: "message", id: "first" }, { type: "compaction", id: "previous" }, { type: "message", id: "tail" }];
  const ctx = { sessionManager: { getBranch: () => branch }, model: { contextWindow: 200000 } };
  const pi = { getSettings: () => ({ compaction: { keepRecentTokens: 20000 } }) };
  assert.deepEqual(compactionDraft(pi as never, ctx as never, "summary", { hash: "abc" }), {
    type: "compaction", summary: "summary", firstKeptEntryId: "tail", details: { source: "task-memory", hash: "abc" },
  });
});

test("latest external compaction invalidates the previous task hash", () => {
  const branch: unknown[] = [{ type: "custom_message", customType: "task-memory-state", details: { hash: "old" } }];
  const ctx = { sessionManager: { getBranch: () => branch } };
  assert.equal(lastKnownHash(ctx as never), "old");
  branch.push({ type: "compaction", details: { source: "other", hash: "other" } });
  assert.equal(lastKnownHash(ctx as never), undefined);
  branch.push({ type: "message", message: { role: "toolResult", toolName: "task", details: { hash: "new" } } });
  assert.equal(lastKnownHash(ctx as never), "new");
});
