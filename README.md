# Pi configuration

`extensions/ui/index.ts` registers the custom UI components in `extensions/ui/editor/`, `extensions/ui/footer/`, and `extensions/ui/widget/`. The footer displays a shaded context-usage bar with visual status levels at 25%, 80%, 90%, 98%, and 100%. These levels are visual indicators, not compaction triggers. `extensions/task-memory/` contains the task-memory extension and its separate handoff warnings. The streaming indicator cycles through eight activity labels with a blue animated star and text; active task-memory phases use the same animated color palette. Reload Pi with `/reload` after changing extensions.

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
