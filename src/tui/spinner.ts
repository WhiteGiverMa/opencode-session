import { createEffect, createSignal, onCleanup } from "solid-js"

/**
 * The exact six-dot braille cycle OpenCode uses for its native session tabs
 * (`packages/tui/src/component/spinner-frames.ts`). Keeping frames and cadence
 * identical makes the plugin's running indicators feel native.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export const SPINNER_INTERVAL_MS = 80

export function normalizeSpinnerIndex(index: number): number {
  const size = SPINNER_FRAMES.length
  return ((Math.trunc(index) % size) + size) % size
}

export function spinnerFrameAt(index: number): string {
  return SPINNER_FRAMES[normalizeSpinnerIndex(index)] ?? SPINNER_FRAMES[0]
}

const [frameIndex, setFrameIndex] = createSignal(0)
let consumers = 0
let timer: ReturnType<typeof setInterval> | undefined

function start(): void {
  if (timer !== undefined) return
  timer = setInterval(() => setFrameIndex((current) => normalizeSpinnerIndex(current + 1)), SPINNER_INTERVAL_MS)
}

function stop(): void {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
  setFrameIndex(0)
}

/** The current shared frame; reactive wherever it is read inside a component. */
export function spinnerFrame(): string {
  return spinnerFrameAt(frameIndex())
}

/**
 * Subscribes a component to the shared spinner. Any number of tabs/rows can
 * consume this while only one interval runs. Pass an `active` predicate so the
 * interval exists only while a running indicator is actually visible; it stops
 * as soon as the last active consumer unmounts or goes idle.
 */
export function useSpinnerFrame(active: () => boolean = () => true): () => string {
  let acquired = false
  const acquire = () => {
    if (acquired) return
    acquired = true
    consumers += 1
    start()
  }
  const release = () => {
    if (!acquired) return
    acquired = false
    consumers = Math.max(0, consumers - 1)
    if (consumers === 0) stop()
  }
  createEffect(() => {
    if (active()) acquire()
    else release()
  })
  onCleanup(release)
  return spinnerFrame
}
