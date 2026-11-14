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
  - Built on `session.panel` with native mouse drag-to-resize, split/fullscreen toggle, full-tree tab strip (including depth > 1 descendants), `[▾ History]` non-destructive tab drawer, smart stick-to-bottom streaming viewport, and per-session draft persistence.
  - Clicking `[Native View ↗]` opens the full native session route for heavy diffs while injecting an unsealed composer via `session.composer.top` so child sessions can be steered or resumed directly.
  - Two-tier **Handoff** sends conclusions back to the main session either along-with-next-turn (`park`, default) or with immediate wake (`wake`).
- **Code Mode `tools.session.*` Namespace**:
  - Core primitives use `pinned: true` so their TypeScript signatures appear inline in the `# Code Mode` catalog without requiring a discovery round-trip.
  - **Inspection**: `list`, `info`, `read` (positive/negative `offset` and `limit` slicing, plus `includeTools` and `includeReasoning` switches), and literal `search`.
  - **Lifecycle & Messaging**: `create`, `peers`, `send` (transmits only the explicit `message` string with zero implicit transcript leakage; supports `wake` vs `park` delivery and automatic downgrade to `park` after `maxWakeHops = 3`), `watch`, `unwatch`, and `wait`.

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

## License

[MIT](LICENSE)
