import solidPlugin from "@opentui/solid/bun-plugin"

// TUI entrypoint: keep host-provided packages external so the bundle binds to
// the running OpenCode TUI's own @opencode/plugin and OpenTUI instances.
const tui = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  target: "node",
  plugins: [solidPlugin],
  external: [
    "@opencode/plugin",
    "@opencode/plugin/tui",
    "@opencode/plugin/rpc",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "solid-js/store",
    "effect",
  ],
})
if (!tui.success) throw new AggregateError(tui.logs, "TUI build failed")

// Server and shared RPC contract entrypoints.
const server = await Bun.build({
  entrypoints: ["./src/server.ts", "./src/contract.ts"],
  outdir: "./dist",
  target: "node",
  external: ["@opencode/plugin", "@opencode/plugin/rpc", "effect", "bun:sqlite", "node:sqlite"],
})
if (!server.success) throw new AggregateError(server.logs, "Server build failed")

console.log("built: dist/server.js, dist/tui.js, dist/contract.js")
