import { findCutPoint, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { CompactionSettings, EntryDetails, ToolResultMessage, HashEntry } from "./compaction.types.ts";

/** Compaction draft that keeps a small raw tail after the previous compaction. */
export function compactionDraft(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  summary: string,
  details: Record<string, unknown>,
): SessionBoundaryDraft {
  const branch = [...ctx.sessionManager.getBranch()];
  let start = 0;

  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type === "compaction") {
      start = i + 1;
      break;
    }
  }

  const setting = (pi.getSettings() as CompactionSettings).compaction?.keepRecentTokens ?? 20000;
  const keep = Math.max(2000, Math.min(setting, Math.floor((ctx.model?.contextWindow ?? 200000) * 0.05)));
  let firstKeptEntryId: string | null = null;

  if (start < branch.length) {
    const cutPoint = findCutPoint(branch, start, branch.length, keep);
    firstKeptEntryId = branch[cutPoint.firstKeptEntryIndex]?.id ?? null;
  }

  return { type: "compaction", summary, firstKeptEntryId, details: { source: "task-memory", ...details } };
}

export function lastKnownHash(ctx: ExtensionContext): string | undefined {
  // SAFETY: only optional fields are read; session entries are a superset of this shape.
  const branch = ctx.sessionManager.getBranch() as unknown as HashEntry[];

  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "compaction") return e.details?.source === "task-memory" ? e.details.hash : undefined;
    if (e.type === "custom_message" && e.customType === "task-memory-state" && e.details?.hash) return e.details.hash;
    if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "task" && e.message.details?.hash) return e.message.details.hash;
  }
  return undefined;
}
