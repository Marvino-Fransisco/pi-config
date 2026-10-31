# Pi configuration

`extensions/ui/index.ts` registers the custom editor, topbar, model footer and animated streaming indicator. `extensions/task-memory/` provides separate context handoff warnings. Run `/context` to toggle the top-right context panel with a colored usage grid, category legend and ranking of retained tool results; `/close` closes either the task or context panel. Focus the panel by clicking it or pressing `Ctrl+Alt+T`, switch task/context tabs with left/right or `h`/`l`, scroll with up/down or `j`/`k`, and press Escape to return focus to the editor. Context data is refreshed when the context tab is opened. The report shows a 20×10 grid beside the model and category legend when the panel is wide enough, and stacks them on narrower terminals. It uses Pi's character-based token estimates, not exact per-category provider counts. Each non-zero category gets at least one grid symbol, so tiny values are visible but may be visually overstated. The grid separately marks Pi's configured auto-compaction reserve; task-memory can trigger compaction earlier. The report does not independently measure tool schemas or skills, or recover tool results discarded by compaction. The streaming indicator cycles through eight activity labels with a blue animated star and text; active task-memory phases use the same animated color palette. Reload Pi with `/reload` after changing extensions.

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
