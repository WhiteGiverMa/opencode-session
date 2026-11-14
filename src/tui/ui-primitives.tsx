import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { generateSyntax } from "@opencode/theme/tui"
import {
  MacOSScrollAccel,
  MouseButton,
  RenderableEvents,
  RGBA,
  TextAttributes,
  type KeyEvent,
  type MouseEvent,
  type MousePointerStyle,
  type ScrollAcceleration,
  type SyntaxStyle,
  type TextareaRenderable,
} from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"

type Theme = Plugin.Context["theme"]

export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
} as const

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
} as const

// ---------------------------------------------------------------------------
// Native CLI scroll acceleration & speed reader (matches OpenCode TUI exactly)
// ---------------------------------------------------------------------------

export interface HostCliScrollConfig {
  readonly acceleration: boolean
  readonly speed: number
  readonly scrollbar: boolean
}

class CustomSpeedScroll implements ScrollAcceleration {
  readonly speed: number
  constructor(speed: number) {
    this.speed = speed
  }
  tick(_now?: number): number {
    return this.speed
  }
  reset(): void {}
}

function stripJsonComments(raw: string): string {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? ""
    const next = raw[i + 1] ?? ""
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1
      out += "\n"
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const val: unknown = JSON.parse(stripJsonComments(raw))
    return typeof val === "object" && val !== null && !Array.isArray(val) ? (val as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function readHostCliScrollConfig(): HostCliScrollConfig {
  let acceleration = false
  let speed = 3
  let scrollbar = false

  const applyFrom = (record: Record<string, unknown> | null) => {
    if (!record) return
    const scroll = record.scroll
    if (typeof scroll === "object" && scroll !== null && !Array.isArray(scroll)) {
      const s = scroll as Record<string, unknown>
      if (typeof s.acceleration === "boolean") acceleration = s.acceleration
      if (typeof s.speed === "number" && Number.isFinite(s.speed) && s.speed > 0) speed = s.speed
    }
    const session = record.session
    if (typeof session === "object" && session !== null && !Array.isArray(session)) {
      const sess = session as Record<string, unknown>
      if (typeof sess.scrollbar === "boolean") scrollbar = sess.scrollbar
    }
  }

  const xdg = process.env.XDG_CONFIG_HOME
  const configRoot = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config")
  for (const filename of ["cli.json", "cli.jsonc"]) {
    const filePath = path.join(configRoot, "opencode", filename)
    if (existsSync(filePath)) {
      try {
        applyFrom(parseRecord(readFileSync(filePath, "utf8")))
        break
      } catch {
        // Ignore unreadable config file and fall back cleanly
      }
    }
  }

  const inline = process.env.OPENCODE_CLI_CONFIG_CONTENT
  if (inline && inline.trim().length > 0) {
    applyFrom(parseRecord(inline))
  }

  return { acceleration, speed, scrollbar }
}

export function createHostScrollAcceleration(config = readHostCliScrollConfig()): ScrollAcceleration {
  if (config.acceleration) {
    return new MacOSScrollAccel()
  }
  return new CustomSpeedScroll(config.speed)
}

// ---------------------------------------------------------------------------
// Theme helpers, agent colors, and Markdown SyntaxStyle lifecycle
// ---------------------------------------------------------------------------

export function useHostSyntaxStyle(context: Plugin.Context): () => SyntaxStyle {
  const retained = new Set<SyntaxStyle>()
  let current: SyntaxStyle | undefined

  const release = (style: SyntaxStyle) => {
    retained.add(style)
    void context.renderer
      .idle()
      .catch(() => {})
      .finally(() => {
        if (!retained.delete(style)) return
        style.destroy()
      })
  }

  onCleanup(() => {
    if (current) release(current)
  })

  return createMemo(() => {
    const previous = current
    current = generateSyntax(context.theme, context.renderer.nativeScene)
    if (previous) release(previous)
    return current
  })
}

export function resolveAgentAccent(theme: Theme, agentID: string | null | undefined): RGBA {
  const palette = theme.categorical
  if (!palette || palette.length === 0) return theme.hue.accent[500]
  if (!agentID) return palette[0]?.[400] ?? theme.hue.accent[500]
  const normalized = agentID.toLowerCase()
  if (normalized === "meidocho" || normalized === "build") return palette[0]?.[400] ?? theme.hue.accent[500]
  if (normalized === "general") return theme.text.feedback.warning.base
  if (normalized === "explore") return theme.text.feedback.info.base
  if (normalized === "oracle") return (palette[2] ?? palette[0])?.[400] ?? theme.hue.accent[500]
  let hash = 0
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0
  }
  const scale = palette[hash % palette.length]
  return scale?.[400] ?? theme.hue.accent[500]
}

export function titlecaseAgent(agentID: string | null | undefined): string {
  if (!agentID) return "Agent"
  return agentID.charAt(0).toUpperCase() + agentID.slice(1)
}

export function setPointer(context: Plugin.Context, style: MousePointerStyle): void {
  try {
    context.renderer.setMousePointer(style)
    context.renderer.requestRender()
  } catch {
    // Older terminals or headless renderers simply ignore pointer style hints
  }
}

// ---------------------------------------------------------------------------
// GuiButton: GUI-like highlighted box button (no ASCII `[x]` brackets)
// ---------------------------------------------------------------------------

export type GuiButtonVariant = "primary" | "secondary" | "ghost" | "success" | "warning" | "danger"

export interface GuiButtonProps {
  readonly context: Plugin.Context
  readonly label: string
  readonly shortcut?: string
  readonly icon?: string
  readonly variant?: GuiButtonVariant
  readonly active?: boolean
  readonly disabled?: boolean
  readonly bold?: boolean
  readonly paddingX?: number
  readonly idleTextColor?: RGBA
  /** Optional pre-focus hook so split-pane clicks claim right-pane focus before stopping propagation. */
  readonly onActivateHost?: () => void
  readonly onClick: (shift: boolean) => void
}

export function GuiButton(props: GuiButtonProps) {
  const [hovered, setHovered] = createSignal(false)
  const [pressed, setPressed] = createSignal(false)

  onCleanup(() => {
    if (hovered()) setPointer(props.context, "default")
  })

  const colors = createMemo(() => {
    const theme = props.context.theme
    const variant = props.variant ?? "secondary"
    const isHovered = hovered() && !props.disabled
    const isPressed = pressed() && !props.disabled

    if (props.disabled) {
      return {
        bg: variant === "ghost" ? undefined : theme.background.raised.base,
        fg: theme.text.action.primary.disabled,
        keyFg: theme.text.faint,
      }
    }

    if (variant === "primary") {
      return {
        bg: isPressed
          ? theme.hue.interactive[500]
          : isHovered
            ? theme.hue.interactive[600]
            : theme.hue.interactive[700],
        fg: theme.text.base,
        keyFg: isHovered ? theme.text.base : theme.text.muted,
      }
    }

    if (variant === "success" || variant === "warning" || variant === "danger") {
      const kind = variant === "danger" ? "error" : variant
      const baseFg = theme.text.feedback[kind].base
      return {
        bg: isPressed
          ? theme.increase(theme.background.raised.max, 1)
          : isHovered
            ? theme.background.raised.max
            : theme.background.raised.high,
        fg: baseFg,
        keyFg: theme.text.muted,
      }
    }

    if (variant === "ghost") {
      return {
        bg: isPressed
          ? theme.background.raised.max
          : isHovered
            ? theme.background.raised.high
            : props.active
              ? theme.background.raised.high
              : undefined,
        fg: isHovered || props.active ? theme.text.base : (props.idleTextColor ?? theme.text.muted),
        keyFg: isHovered ? theme.text.muted : theme.text.faint,
      }
    }

    // Default "secondary": subtle raised surface at rest (600), brightens on hover (500)
    return {
      bg: isPressed
        ? theme.increase(theme.background.raised.max, 1)
        : isHovered
          ? theme.background.raised.max
          : props.active
            ? theme.hue.interactive[700]
            : theme.background.raised.high,
      fg: isHovered || props.active ? theme.text.base : theme.text.muted,
      keyFg: isHovered ? theme.text.muted : theme.text.faint,
    }
  })

  const padX = () => props.paddingX ?? 1

  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={padX()}
      paddingRight={padX()}
      backgroundColor={colors().bg}
      onMouseOver={() => {
        if (props.disabled) return
        setHovered(true)
        setPointer(props.context, "pointer")
      }}
      onMouseOut={() => {
        setHovered(false)
        setPressed(false)
        setPointer(props.context, "default")
      }}
      onMouseDown={(event: MouseEvent) => {
        if (event.button !== MouseButton.LEFT || props.disabled) return
        props.onActivateHost?.()
        event.stopPropagation()
        setPressed(true)
      }}
      onMouseUp={(event: MouseEvent) => {
        if (event.button !== MouseButton.LEFT) return
        event.stopPropagation()
        setPressed(false)
        if (!props.disabled) props.onClick(event.modifiers.shift)
      }}
    >
      <text
        wrapMode="none"
        selectable={false}
        attributes={props.bold || props.active || props.variant === "primary" ? TextAttributes.BOLD : undefined}
      >
        <Show when={props.icon}>
          <span style={{ fg: colors().fg }}>{`${props.icon} `}</span>
        </Show>
        <span style={{ fg: colors().fg }}>{props.label}</span>
        <Show when={props.shortcut}>
          <span style={{ fg: colors().keyFg }}>{` ${props.shortcut}`}</span>
        </Show>
      </text>
    </box>
  )
}

// ---------------------------------------------------------------------------
// GraphicalPromptCard: Exact replica of OpenCode's graphical <Prompt> card
// ---------------------------------------------------------------------------

export interface GraphicalPromptCardProps {
  readonly context: Plugin.Context
  readonly syntaxStyle: SyntaxStyle
  readonly valueKey: string
  readonly initialValue: string
  readonly placeholder: string
  readonly agentLabel: string
  readonly agentAccent: RGBA
  readonly modelLabel: string
  readonly providerLabel?: string
  readonly variantLabel?: string
  readonly statusLabel?: string
  readonly running?: boolean
  readonly minHeight?: number
  readonly maxHeight?: number
  readonly footerHint?: string
  readonly actions?: JSX.Element
  readonly topSlot?: JSX.Element
  readonly onActivateHost?: () => void
  readonly onFocusChange?: (focused: boolean) => void
  readonly onDraftChange: (value: string) => void
  readonly onSubmit: (queue: boolean) => void
  readonly onInterrupt?: () => void
  readonly onEscape?: () => void
  readonly inputRef?: (area: TextareaRenderable | undefined) => void
}

export function GraphicalPromptCard(props: GraphicalPromptCardProps) {
  const theme = props.context.theme
  const [focused, setFocused] = createSignal(false)
  const [hovered, setHovered] = createSignal(false)
  let textarea: TextareaRenderable | undefined

  const promptBg = createMemo(() => theme.decrease(theme.background.raised.base))
  const borderHighlight = createMemo(() =>
    focused() ? props.agentAccent : hovered() ? theme.increase(theme.border.base, 1) : theme.border.base,
  )

  const focusEditor = (event?: MouseEvent) => {
    if (event && event.button !== MouseButton.LEFT) return
    props.onActivateHost?.()
    event?.stopPropagation()
    if (textarea && !textarea.isDestroyed) {
      textarea.focus()
      props.context.renderer.requestRender()
    }
  }

  createEffect(() => {
    const key = props.valueKey
    if (!textarea || textarea.isDestroyed) return
    const next = props.initialValue
    if (textarea.plainText !== next) {
      textarea.setText(next)
      textarea.gotoLineEnd()
    }
    void key
  })

  onCleanup(() => {
    if (hovered()) setPointer(props.context, "default")
    props.inputRef?.(undefined)
  })

  return (
    <box width="100%" flexDirection="column" flexShrink={0}>
      {/* Main graphical prompt card with left accent bar */}
      <box
        width="100%"
        border={["left"]}
        borderColor={borderHighlight()}
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
          bottomLeft: "╹",
        }}
        onMouseOver={() => {
          setHovered(true)
          setPointer(props.context, "text")
        }}
        onMouseOut={() => {
          setHovered(false)
          setPointer(props.context, "default")
        }}
        onMouseDown={focusEditor}
      >
        <box
          width="100%"
          flexGrow={1}
          flexShrink={0}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          backgroundColor={promptBg()}
        >
          <Show when={props.topSlot}>
            <box paddingBottom={1} flexShrink={0}>
              {props.topSlot}
            </box>
          </Show>

          <textarea
            ref={(area: TextareaRenderable) => {
              textarea = area
              props.inputRef?.(area)
              const onFocus = () => {
                setFocused(true)
                props.onFocusChange?.(true)
              }
              const onBlur = () => {
                setFocused(false)
                props.onFocusChange?.(false)
              }
              area.on(RenderableEvents.FOCUSED, onFocus)
              area.on(RenderableEvents.BLURRED, onBlur)
              onCleanup(() => {
                area.off(RenderableEvents.FOCUSED, onFocus)
                area.off(RenderableEvents.BLURRED, onBlur)
              })
              if (props.initialValue && area.plainText !== props.initialValue) {
                area.setText(props.initialValue)
                area.gotoLineEnd()
              }
            }}
            width="100%"
            minHeight={props.minHeight ?? 2}
            maxHeight={props.maxHeight ?? 6}
            wrapMode="word"
            placeholder={props.placeholder}
            placeholderColor={theme.text.muted}
            textColor={theme.text.base}
            focusedTextColor={theme.text.base}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            cursorColor={theme.text.base}
            syntaxStyle={props.syntaxStyle}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "kpenter", action: "submit" },
              { name: "return", shift: true, action: "newline" },
              { name: "kpenter", shift: true, action: "newline" },
            ]}
            onMouseDown={focusEditor}
            onContentChange={() => {
              if (!textarea || textarea.isDestroyed) return
              props.onDraftChange(textarea.plainText)
            }}
            onKeyDown={(event: KeyEvent) => {
              if ((event.name === "return" || event.name === "kpenter") && (event.meta || event.option)) {
                event.preventDefault()
                event.stopPropagation()
                props.onSubmit(true)
                return
              }
              if (event.ctrl && event.name === "x" && props.onInterrupt) {
                event.preventDefault()
                event.stopPropagation()
                props.onInterrupt()
                return
              }
              if (event.name === "escape") {
                event.preventDefault()
                event.stopPropagation()
                if (props.onEscape) props.onEscape()
                else textarea?.blur()
              }
            }}
            onSubmit={() => {
              setTimeout(() => setTimeout(() => props.onSubmit(false), 0), 0)
            }}
          />

          {/* Metadata & inline GUI action bar matching OpenCode native PromptMetadataRow */}
          <box
            flexDirection="row"
            flexShrink={0}
            paddingTop={1}
            gap={1}
            justifyContent="space-between"
            alignItems="center"
          >
            <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
              <text fg={props.agentAccent} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0} selectable={false}>
                {props.agentLabel}
              </text>
              <Show when={props.modelLabel}>
                <text fg={theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>
                  ·
                </text>
                <text
                  fg={focused() ? theme.text.base : theme.text.muted}
                  wrapMode="none"
                  truncate
                  flexShrink={1}
                  minWidth={0}
                  selectable={false}
                >
                  {props.modelLabel}
                </text>
              </Show>
              <Show when={props.providerLabel}>
                {(provider) => (
                  <text fg={theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>
                    {provider()}
                  </text>
                )}
              </Show>
              <Show when={props.variantLabel}>
                {(variant) => (
                  <>
                    <text fg={theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>
                      ·
                    </text>
                    <text
                      fg={theme.text.feedback.warning.base}
                      attributes={TextAttributes.BOLD}
                      wrapMode="none"
                      flexShrink={0}
                      selectable={false}
                    >
                      {variant()}
                    </text>
                  </>
                )}
              </Show>
              <Show when={props.statusLabel}>
                {(status) => (
                  <>
                    <text fg={theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>
                      ·
                    </text>
                    <text
                      fg={props.running ? theme.text.feedback.info.base : theme.text.muted}
                      wrapMode="none"
                      flexShrink={0}
                      selectable={false}
                    >
                      {status()}
                    </text>
                  </>
                )}
              </Show>
            </box>

            <Show when={props.actions}>
              <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
                {props.actions}
              </box>
            </Show>
          </box>
        </box>
      </box>

      {/* Signature half-block bottom edge (`╹▀▀▀▀▀▀▀▀`) exactly matching OpenCode native Prompt */}
      <box
        height={1}
        width="100%"
        border={["left"]}
        borderColor={borderHighlight()}
        customBorderChars={{
          ...EmptyBorder,
          vertical: promptBg().a !== 0 ? "╹" : " ",
        }}
      >
        <box
          height={1}
          width="100%"
          border={["bottom"]}
          borderColor={promptBg()}
          customBorderChars={
            promptBg().a !== 0
              ? {
                  ...EmptyBorder,
                  horizontal: "▀",
                }
              : {
                  ...EmptyBorder,
                  horizontal: " ",
                }
          }
        />
      </box>

      <Show when={props.footerHint}>
        {(hint) => (
          <box height={1} paddingLeft={2} paddingRight={1} flexShrink={0}>
            <text fg={theme.text.muted} wrapMode="none" truncate selectable={false}>
              {hint()}
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}
