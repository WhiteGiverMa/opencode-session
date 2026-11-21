# opencode-session

English | [简体中文](README.md)

Unified session collaboration plugin (`o3p.session`) for OpenCode v2: upgrades `/btw` into persistent streaming forked asides, provides a resizable split/fullscreen TUI console for human subagent micromanagement, and exposes `tools.session.*` inside Code Mode for inter-session messaging and transcript slicing.

## Highlights

- **Persistent Streaming `/btw` Asides**:
  - Uses native `session.fork` to inherit settled context, active agent identity (compatible with `opencode-prompts`), and prompt-cache affinity.
  - Marks forked asides `archived: true` so they stay out of the top-level `/sessions` picker while remaining live and organized under their root session.
  - Starts with a workspace read-only lock (`write`/`edit` removed while keeping `read`/`grep`/`glob`/`shell` for inspection), with a one-click unlock toggle in the panel header.
- **`/sub` Direct Spawning & Full-Tree TUI Console**:
  - Run `/sub [@agent] [task]` to spawn a fresh specialist session directly into the right split pane without spending a main-session turn.
  - Built on `session.panel` with native mouse drag-to-resize, split/fullscreen toggle, adaptive full-tree tab strip with right-click context menu (rename, copy ID, reopen closed tabs), expandable `$ shell` & `+ Thought` timeline blocks, smart stick-to-bottom streaming viewport, and graphical prompt cards with per-session draft persistence.
  - Clicking `Native View` opens the full native session route for heavy diffs while injecting a slim 1-row collapsible composer via `session.composer.top` so child sessions can be steered or resumed on demand without crowding the view.
  - Two-tier **Handoff** sends conclusions back to the main session either along-with-next-turn (`park`, default) or with immediate wake (`wake`).
- **Code Mode `tools.session.*` Namespace**:
  - Core primitives use `pinned: true` so their TypeScript signatures appear inline in the `# Code Mode` catalog without requiring a discovery round-trip.
  - **Inspection**: `list`, `info`, `read` (positive/negative `offset` and `limit` slicing, plus `includeTools` and `includeReasoning` switches), and literal `search`.
  - **Lifecycle & Messaging**: `create` (stages a valid `ses_...` ID in memory and materializes into the store only upon its first `send`), `peers`, `send` (supports sending to existing/staged IDs or inline `create: { agent, title }`; transmits only the explicit `message` string with zero implicit transcript leakage; supports `wake` vs `park` delivery and automatic downgrade to `park` after `maxWakeHops = 3`), `watch`, `unwatch`, and `wait`.

## Installation & Build

Requires Bun `>= 1.3` and OpenCode v2 (`@opencode/plugin` `2.3.0` types, compatible with `>= 2.2.0`).

```bash
bun install
bun run build
```

Add the plugin directory to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-session",
      "options": {
        "maxWakeHops": 3,
        "btwReadonlyByDefault": true,
        "enableSessionTools": true,
        "replaceNativeSubagentTool": false
      }
    }
  ]
}
```

Disable the built-in modal `/btw` plugin once via `/plugins` -> `Ctrl+A` -> toggle `opencode.btw` off.

## Commands and shortcuts

| Entry / key | Action |
| --- | --- |
| `/btw [question]` | Fork a persistent aside and stream its answer in the right pane |
| `/sub [@agent] [task]` | Spawn a named subagent directly into the right pane |
| `/aside` (alias `/pager`) | Toggle the right-pane aside console; history and drafts are preserved |
| `/tree` (aliases `/aside-list`, `/sessions`) or `Alt+T` | Open the session tree manager for the whole root family, including hidden asides; search, `Enter` to unhide/open, `Alt+H`/`Alt+U`/`Alt+I` to hide/unhide/interrupt |
| `Ctrl+X` + secondary key in the pane | Reaches OpenCode's native `<leader>` sequences (e.g. `Ctrl+X L`, `Ctrl+X B`) unchanged |
| `Alt+X` in the pane | Interrupt the current aside session |

## License

[MIT](LICENSE)
