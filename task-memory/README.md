# task-memory

Pi extension that keeps long-running work resumable across context compaction and new sessions.

## What it does

- **Durable state** in `<git root>/.pi/memory/` (it contains its own `.gitignore` with `*`, so nothing gets committed; a bare `.pi/` does not trigger Pi's project-trust prompt):
  - `task.json`: the active task (goal, steps with verification evidence, decisions, issues, notes, next action, latest handoff)
  - `project.json`: durable repo knowledge (decisions, conventions, verify commands, key paths)
  - `archive/`: finished or abandoned tasks
- **`task` tool** for the model: `start`, `plan`, `step`, `update`, `checkpoint`, `finish`, `show`.
  It enforces one step in progress at a time, evidence before `done`, a final verification plus a docs note at `finish`, and size caps so memory stays short. A missing `action` is inferred when the other fields make it unambiguous.
- **Handoff at compaction**: before compacting, the agent writes a checkpoint (next action, *Read now* / *Read later* / *Known* files, critical context). The checkpoint becomes the compaction summary. The last min(20k tokens, 5% of the window) stays as raw messages.
- **Context thresholds**
  - ≥ 25%: warning. The agent writes a handoff and compacts at the next step boundary, or when the run ends.
  - ≥ 40%: mandatory. Every tool except `task` is blocked until the handoff exists; after 3 ignored turns an automatic handoff is used.
  - `/compact` also has the agent write the handoff first; if it doesn't, an automatic handoff is used.
  - Pi's own auto-compaction stays on as a safety net. If it fires, the saved task state is re-injected afterwards.
- **Headless runs** (`pi -p`, `--mode json`): no turn is added after the final answer, so the printed answer stays intact. The end-of-run handoff and the progress reminder are skipped; at 40% an automatic handoff is used.
- **New session**: saved state is loaded silently, with a one-line notice. The agent continues only if your request relates to it, you say "continue", or you run `/task resume`.
- **Progress sync**: if a run edits files during an active task but never updates it, one short extra turn records progress.
- **Phase widget** (below the editor): `idle · thinking · planning · exploring · coding · verifying · handoff · compacting · resuming`, with the task title, step progress, and a context warning line.

## Commands

| Command | Effect |
| --- | --- |
| `/task` | Show task and project memory |
| `/task resume` | Continue the active task |
| `/task abandon` | Archive the active task as abandoned |

## Configuration

| Env var | Default |
| --- | --- |
| `TASK_MEMORY_WARN_PCT` | `25` |
| `TASK_MEMORY_MUST_PCT` | `40` |

## Files

- `index.ts`: Pi wiring (tool, command, hooks, widget)
- `state.ts`: data model, rules, rendering, storage (no Pi imports)
- `phase.ts`: tool classification, phase, thresholds (no Pi imports)
- `prompts.ts`: text sent to the model

## Development

```bash
npm install
npm test            # unit + hook tests (Pi packages stubbed), no model calls
npm run typecheck   # tsconfig paths point at the installed Pi release
ln -s "$PWD/task-memory" ~/.pi/agent/extensions/task-memory   # install
```

After a Pi upgrade, update the release path in `tsconfig.json`.

## Known limits

- One active task per checkout (git worktrees each get their own). Two sessions in the same checkout: the last write wins.
- Edits made through `bash` (sed, redirects) are not tracked as touched files.
- Memory lives on disk, so it does not rewind with `/tree`.
- An intercepted `/compact` may be reported as cancelled before the handoff turn runs.
- The `/task` panel does not scroll.
