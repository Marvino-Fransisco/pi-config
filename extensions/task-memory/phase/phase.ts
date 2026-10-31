// Pure helpers: tool classification, UI phase, context thresholds. No Pi imports.
import type { Phase, ToolKind, ToolArguments, PhaseInput, Level, Thresholds } from "./phase.types.ts";

const EDIT = new Set(["edit", "write", "ast_grep_replace"]);
const READ = new Set(["read", "grep", "find", "ls", "read_symbol", "read_enclosing", "module_report", "project_report", "symbol_search", "ast_grep_search", "ast_grep_outline", "lsp_navigation"]);
const VERIFY = new Set(["lens_diagnostics"]);
const WEB = new Set(["web_search", "fetch_content", "get_search_content", "source_check"]);

const VERIFY_RE = /\b(test|tests|vitest|jest|pytest|mocha|tsc|typecheck|lint|eslint|biome|ruff|mypy|cargo (test|check|clippy)|go (test|vet)|build|make check)\b/;
const READONLY_RE = /^\s*(ls|cat|head|tail|wc|grep|rg|find|fd|tree|pwd|echo|git (status|log|diff|show|branch))\b/;

export function classifyTool(name: string, args: unknown): ToolKind {
  const input = args as ToolArguments | null | undefined;

  if (name === "task") return input?.action === "checkpoint" ? "checkpoint" : "task";
  if (EDIT.has(name)) return "edit";
  if (READ.has(name)) return "read";
  if (VERIFY.has(name)) return "verify";
  if (WEB.has(name)) return "web";
  if (name === "bash") {
    const cmd = String(input?.command ?? "");
    if (READONLY_RE.test(cmd) && !VERIFY_RE.test(cmd)) return "read";
    if (VERIFY_RE.test(cmd)) return "verify";
    return "other";
  }
  return "other";
}

const PRIORITY: ToolKind[] = ["checkpoint", "verify", "edit", "task", "web", "read", "other"];

export function derivePhase(i: PhaseInput): Phase {
  if (i.compacting) return "compacting";
  if (!i.running) return "idle";
  if (i.handoff) return "handoff";
  const k = PRIORITY.find((p) => i.active.includes(p));
  if (k) return kindPhase(k, i);
  if (i.resuming) return "resuming";
  if (i.last === "verify") return "verifying";
  if (i.last === "edit" || i.stepDoing) return "coding";
  if (i.last === "read" || i.last === "web") return "exploring";
  return i.hasTask ? "planning" : "thinking";
}

function kindPhase(k: ToolKind, i: PhaseInput): Phase {
  switch (k) {
    case "checkpoint": return "handoff";
    case "verify": return "verifying";
    case "edit": return "coding";
    case "task": return "planning";
    case "read": case "web": return i.resuming ? "resuming" : "exploring";
    default: return i.stepDoing ? "coding" : "thinking";
  }
}

export const PHASE_ICON: Record<Phase, string> = {
  idle: "○", thinking: "✦", planning: "◇", exploring: "◎", coding: "●",
  verifying: "◆", handoff: "⇄", compacting: "↻", resuming: "↺",
};

export function readThresholds(env: Record<string, string | undefined>): Thresholds {
  const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 100 ? n : d; };
  const warn = num(env.TASK_MEMORY_WARN_PCT, 50);
  const must = num(env.TASK_MEMORY_MUST_PCT, 75);
  return warn < must ? { warn, must } : { warn: 50, must: 75 };
}

/** baseline = context % measured right after our last compaction; keeps thresholds above it so we don't re-trigger instantly. */
export function contextLevel(pct: number | null | undefined, th: Thresholds, baseline?: number): Level {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "unknown";
  const warn = baseline === undefined ? th.warn : Math.max(th.warn, baseline + 5);
  const must = Math.max(th.must, warn + th.must - th.warn);
  if (pct >= must) return "must";
  if (pct >= warn) return "warn";
  return "ok";
}
