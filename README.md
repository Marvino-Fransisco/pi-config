# Pi configuration

`extensions/ui/index.ts` registers the custom editor, topbar and model footer. `extensions/task-memory/` provides separate context handoff warnings. Run `/context` to toggle the top-right context panel with a colored usage grid, category legend and ranking of retained tool results; `/task`, `/context`, and `/memory` each open an independent top-right panel, replacing the previously open panel. There are no cross-panel tabs or left/right navigation. `/close` (provided by task-memory) closes the active panel. Panels receive focus when opened; scroll with up/down or `j`/`k` and press Escape to return focus to the editor. Click to refocus; `Ctrl+Alt+T` focuses task notes only. Context data refreshes once per second while open. The report shows a 20×10 grid beside the model and category legend when the panel is wide enough, and stacks them on narrower terminals. It uses Pi's character-based token estimates, not exact per-category provider counts. Each non-zero category gets at least one grid symbol, so tiny values are visible but may be visually overstated. The grid separately marks Pi's configured auto-compaction reserve; task-memory can trigger compaction earlier. The report does not independently measure tool schemas or skills, or recover tool results discarded by compaction. The current path appears below the editor. The task-memory phase row above the editor shows the animated working star and current phase; Pi's normal working indicator is retained if the task-memory widget is unavailable. Reload Pi with `/reload` after changing extensions.

In the TUI, a fresh session (startup or `/new` with no messages yet) shows a blue dashboard centered over the empty transcript in place of Pi's startup header: logo, version, model, working directory and branch, the active task when task-memory is loaded, and actions. Click a quick action (resume task, task notes, context, memory) to run its command; actions whose command is not registered are hidden. The first submitted message slides the dashboard up and away over about 300 ms. Set `"quietStartup": true` in `~/.pi/agent/settings.json` to hide Pi's loaded-resource listing below it.

The separate [long-memory extension](extensions/long-memory/README.md) provides explicit global and project memories with PostgreSQL, pgvector, Gemini embeddings, and a management TUI with statistics, scoped search/list filters, retrieval debug, and details. Writes require confirmation; exact duplicates are reused and content replacements retain revision history. See its README for the additive migration required by existing databases.

## Scrolling inside tmux

`tmux-scroll.conf` adds wheel routing for fullscreen applications without mouse reporting. With `set -g mouse on`, scrolling over such a pane sends Page Up/Down (one page per wheel event). Applications that request mouse input and tmux copy mode retain native mouse handling. Normal shell panes use tmux scrollback.

Load it after plugins in `~/.tmux.conf`:

```tmux
source-file ~/Documents/work/tools/pi-config/tmux-scroll.conf
```

Apply without restarting sessions:

```sh
tmux source-file ~/Documents/work/tools/pi-config/tmux-scroll.conf
```

In Pi, Page Up/Down scroll the fullscreen transcript; Home/End jump to its beginning/end. These actions must remain enabled in Pi keybindings. On a Mac keyboard, Fn+Up/Down commonly sends Page Up/Down.

To remove the fallback, remove the source line and restart tmux when your sessions are finished. Do not kill a running tmux server just to reload configuration.
