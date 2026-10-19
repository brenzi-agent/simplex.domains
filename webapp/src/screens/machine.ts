export type Motion = "in-place" | "forward" | "back" | "screen"
export type PageMotion = Exclude<Motion, "in-place">
export interface Machine<S, E, K extends string> {
  name: string
  reduce: (state: S, event: E) => S
  screenOf: (state: S) => K
  moves: { readonly [F in K]: Partial<Record<K, PageMotion>> }
}
interface Step<S, K> { state: S; screen: K; motion: Motion; expected: boolean }

export interface Hold { until: number; lead: string }
export const NO_LEAD = ""

export function step<S, E, K extends string>(machine: Machine<S, E, K>, state: S, shown: K | null, event: E, warn: (message: string) => void = console.warn): Step<S, K> {
  const next = machine.reduce(state, event)
  const screen = machine.screenOf(next)
  if (shown === null) return { state: next, screen, motion: "screen", expected: true }
  if (screen === shown) return { state: next, screen, motion: "in-place", expected: true }
  const motion = machine.moves[shown][screen]
  if (motion) return { state: next, screen, motion, expected: true }
  warn(`[screens] ${machine.name}: unexpected move ${shown} → ${screen}`)
  return { state: next, screen, motion: "screen", expected: false }
}

export function headingFocus<S, K>(result: Step<S, K>, shown: K | null, hadFocus: boolean): boolean | null {
  return shown === null || result.motion === "in-place" ? null : hadFocus
}
