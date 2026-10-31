# task-memory

Pi extension that keeps long-running work resumable across context compaction and new sessions.

## What it does

- **Durable state** in `<git root>/.pi/memory/` (it contains its own `.gitignore` with `*`, so nothing gets committed; a bare `.pi/` does not trigger Pi's project-trust prompt):
  - `task.json`: the active task (goal, steps with verification evidence, decisions, issues, notes, next action, latest handoff)
  - `project.json`: durable repo knowledge (decisions, conventions, verify commands, key paths)
  - `thresholds.json`: per-checkout warning and mandatory handoff settings, when set with `/task threshold`
  - `archive/`: finished or abandoned tasks
- **`task` tool** for the model: `start`, `plan`, `step`, `update`, `checkpoint`, `finish`, `show`.
  It enforces one step in progress at a time, evidence before `done`, a final verification plus a docs note at `finish`, and size caps so memory stays short. A missing `action` is inferred when the other fields make it unambiguous.
- **Handoff at compaction**: before compacting, the agent writes a checkpoint (next action, *Read now* / *Read later* / *Known* files, critical context). The checkpoint becomes the compaction summary. The last min(20k tokens, 5% of the window) stays as raw messages.
- **Context thresholds**
  - ≥ 50% by default: warning. The agent writes a handoff and compacts at the next step boundary, or when the run ends.
  - ≥ 75% by default: mandatory. Every tool except `task` is blocked until the handoff exists. After 3 ignored turns, the conversation is retained and the block is lifted; Pi's normal auto-compaction or a subsequent `/compact` can summarize it.
  - `/compact` also has the agent write the handoff first. If it doesn't, the conversation is retained; run `/compact` again to use Pi's default summarizer.
  - Pi's own auto-compaction stays on as a safety net. If it fires, the saved task state is re-injected afterwards and may need reconciliation with the summary.
- **Headless runs** (`pi -p`, `--mode json`): no turn is added after the final answer, so the printed answer stays intact. The end-of-run handoff and the progress reminder are skipped; if a handoff is unavailable at the mandatory threshold, the conversation is retained for Pi's normal compaction.
- **New session**: saved state is loaded silently, with a one-line notice. The agent continues only if your request relates to it, you say "continue", or you run `/task resume`.
- **Progress sync**: if a run edits files during an active task but never updates it, one short extra turn records progress.
- **Phase widget** (below the editor): `idle · thinking · planning · exploring · coding · verifying · handoff · compacting · resuming`, with animated blue active phases, the task title, step progress, and a context warning line.

## Commands

| Command | Effect |
| --- | --- |
| `/task` | Toggle the task and project memory notes panel |
| `/task resume` | Continue the active task |
| `/task abandon` | Archive the active task as abandoned |
| `/task threshold` | Show the current warning and mandatory handoff percentages |
| `/task threshold warning 20` | Set the warning percentage |
| `/task threshold mandatory 65` | Set the mandatory handoff percentage |

The notes panel stays open while typing and refreshes from disk once per second. Click the panel in fullscreen mode or press `Ctrl+Alt+T` (`Control+Option+T` on Mac) to focus it; use the mouse wheel, arrow keys or `j`/`k` to scroll, and press `Esc` to return to the editor. The panel is hidden when the terminal is smaller than 80 columns or 12 rows.

## Configuration

| Env var | Default |
| --- | --- |
| `TASK_MEMORY_WARN_PCT` | `50` |
| `TASK_MEMORY_MUST_PCT` | `75` |

Both values must satisfy `0 < warning < mandatory < 100`. Command settings persist per checkout and override environment variables. Without saved settings, environment variables override the defaults; an invalid ordering falls back to both defaults. After compaction, thresholds may temporarily be raised above the post-compaction baseline to avoid an immediate repeat. The warning itself requests compaction at the next step boundary, so the mandatory threshold may never be reached.

## Files

- `index.ts`: Pi registration, lifecycle hooks, and shared runtime state
- `actions/`: task tool action handling
- `schema/`: task tool input schema
- `compaction/`: compaction draft and session hash lookup
- `ui/`: phase widget and sticky notes overlay
- `state/`: data model, rules, rendering, storage (no Pi imports)
- `phase/`: tool classification, phase, thresholds (no Pi imports)
- `prompts/`: text sent to the model

Each module with its own types keeps them in a corresponding `*.types.ts` file beside its implementation. The root `index.ts` remains the Pi extension entry point.

## Development

```bash
npm install
npm test            # unit + hook tests (Pi packages stubbed), no model calls
npm run typecheck   # tsconfig paths point at the installed Pi release
ln -s "$PWD/extensions/task-memory" ~/.pi/agent/extensions/task-memory   # install
```

After a Pi upgrade, update the release path in `tsconfig.json`.

## Known limits

- One active task per checkout (git worktrees each get their own). Two sessions in the same checkout: the last write wins.
- Edits made through `bash` (sed, redirects) are not tracked as touched files.
- Memory lives on disk, so it does not rewind with `/tree`.
- An intercepted `/compact` may be reported as cancelled before the handoff turn runs.
- The notes panel overlays existing terminal content; it does not reserve a separate column.
