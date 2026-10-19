import { expect, type Page } from "@playwright/test"
import { CROSS_FAINT, CROSS_HELD } from "../src/motion-values.ts"

// What a sweep reads: a view transition's picture ("::view-transition-new(page)"), or the elements a selector finds,
// drawn as much as the most drawn of them, through their ancestors' opacity; "color" reads the alpha of their text
// colour too, and a selector ending in "::after" reads that pseudo-element; "or" is the picture read when the first is
// not drawn, as the old page is pictured apart when the window scrolls. "over" is 1 while a view transition's group box
// (as "::view-transition-group(order-name)") overlaps any of the elements its selector finds, else 0.
export type Side = { css: string; color?: boolean; or?: string } | { over: [string, string] }
export interface Frame { t: number; at: Record<string, number> }
export interface Swept { frames: Frame[]; blends: string[] }
// what the sweep waits for: a view transition, or animations on the elements a selector finds
export type Watch = { transition: true } | { within: string }

const STEP_MS = 4
// how long a sweep waits for its change to start
const ARMED_MS = 10_000
// the sweep's reading of an opacity, which a browser rounds
const SLACK = 0.02

// Arms a sweep in the page: once the change starts, every animation it runs is paused and set to each moment of its
// whole run in turn, and every side is read at each. Start the change after this and await the result after it.
export function sweep(page: Page, watch: Watch, sides: Record<string, Side>): Promise<Swept> {
  return page.evaluate(async ([watch, sides, step, wait]) => {
    const w = window as unknown as { __lastTransition?: ViewTransition | null }
    const before = w.__lastTransition ?? null
    const finite = (x: Animation) => x.playState === "running" && Number.isFinite(x.effect?.getComputedTiming().endTime ?? Infinity)
    const found = () => "within" in watch ? [...document.querySelectorAll(watch.within)].flatMap((n) => n.getAnimations({ subtree: true })).filter(finite) : []
    let animations: Animation[] = []
    const armed = performance.now()
    for (;;) {
      await new Promise(requestAnimationFrame)
      if (performance.now() - armed > wait) throw new Error(`nothing started within ${wait} ms: ${JSON.stringify(watch)}`)
      if ("transition" in watch && (w.__lastTransition ?? null) !== before) {
        await w.__lastTransition!.ready.catch(() => undefined)
        animations = document.getAnimations().filter(finite)
        break
      }
      if (found().length) {
        await Promise.all(found().map((x) => x.ready))
        // what the same change starts in the overlay or part around them, as an overlay's surface
        animations = [...new Set([...found(), ...document.body.getAnimations({ subtree: true }).filter(finite)])]
        break
      }
    }
    const started = new Map(animations.map((x) => [x, Number(x.startTime ?? 0)]))
    const left = new Map(animations.map((x) => [x, Number(x.currentTime ?? 0)]))
    animations.forEach((x) => x.pause())
    const first = Math.min(...started.values())
    const last = Math.max(...animations.map((x) => started.get(x)! + Number(x.effect!.getComputedTiming().endTime)))
    const pictures = animations.map((x) => (x.effect as KeyframeEffect).pseudoElement ?? "").filter((p) => /^::view-transition-(old|new)\(/.test(p))
    const alpha = (color: string) => {
      const parts = /rgba?\(([^)]+)\)/.exec(color)?.[1].split(/[\s,/]+/).filter(Boolean) ?? []
      return parts.length > 3 ? Number(parts[3]) : 1
    }
    const overlaps = ([group, selector]: [string, string]) => {
      const style = getComputedStyle(document.documentElement, group)
      const [a, , , d, x, y] = new DOMMatrix(style.transform).toFloat64Array().filter((_, i) => [0, 1, 4, 5, 12, 13].includes(i))
      const box = { left: x, top: y, right: x + parseFloat(style.width) * a, bottom: y + parseFloat(style.height) * d }
      return [...document.querySelectorAll(selector)].some((n) => {
        const r = n.getBoundingClientRect()
        return r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top
      }) ? 1 : 0
    }
    const read = (side: Side) => "over" in side ? overlaps(side.over) : drawn(side)
    const drawn = ({ css, color, or }: { css: string; color?: boolean; or?: string }) => {
      if (css.startsWith("::")) return Number(getComputedStyle(document.documentElement, or && !pictures.includes(css) ? or : css).opacity)
      const [selector, pseudo] = css.split(/(?=::)/)
      return Math.max(0, ...[...document.querySelectorAll(selector)].map((n) => {
        const style = getComputedStyle(n, pseudo)
        if (style.visibility === "hidden" || style.display === "none") return 0
        let opacity = Number(style.opacity) * (color ? alpha(style.color) : 1)
        for (let up = n.parentElement; up; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity)
        return opacity
      }))
    }
    const frames: { t: number; at: Record<string, number> }[] = []
    let blends: string[] = []
    for (let t = 0; t <= last - first; t += step) {
      animations.forEach((x) => { x.currentTime = first + t - started.get(x)! })
      frames.push({ t, at: Object.fromEntries(Object.entries(sides).map(([key, side]) => [key, read(side)])) })
      if (!blends.length) blends = [...new Set(pictures.map((p) => getComputedStyle(document.documentElement, p).mixBlendMode))]
    }
    animations.forEach((x) => {
      x.currentTime = left.get(x)!
      x.play()
    })
    return { frames, blends }
  }, [watch, sides, STEP_MS, ARMED_MS] as const)
}

const shown = (frames: Frame[], keys: string[]) => frames.map((f) => `${f.t}:${keys.map((k) => f.at[k].toFixed(2)).join("/")}`).join(" ")

// A crossing from a to b, each read as a share of how it is drawn at rest, as a button turned off draws its label
// fainter: in every frame one of them reads clearly, the fainter no more than CROSS_FAINT, and together they never
// show less than CROSS_HELD + CROSS_FAINT.
export function expectCrossing({ frames, blends }: Swept, a: string, b: string): void {
  const what = `${a} → ${b}`
  const all = shown(frames, [a, b])
  expect(frames.length, `${what}: frames swept`).toBeGreaterThan(1)
  const [from, to] = [frames[0].at[a], frames.at(-1)!.at[b]]
  expect(Math.min(from, to), `${what}: drawn at all at rest; ${all}`).toBeGreaterThan(SLACK)
  const share = frames.map((f) => ({ t: f.t, a: f.at[a] / from, b: f.at[b] / to }))
  const thin = share.find((f) => f.a + f.b < CROSS_HELD + CROSS_FAINT - SLACK)
  expect(thin, `${what}: the place thins out at ${thin?.t} ms; ${all}`).toBeUndefined()
  const doubled = share.find((f) => Math.min(f.a, f.b) > CROSS_FAINT + SLACK)
  expect(doubled, `${what}: both read at ${doubled?.t} ms; ${all}`).toBeUndefined()
  expect(blends.filter((m) => m !== "normal"), `${what}: pictures blended other than normally`).toEqual([])
}

// An overlay's surface and its text: the text is drawn only over the whole surface, as it comes in and as it goes.
export function expectCovered({ frames }: Swept, surface: string, text: string, coming: boolean): void {
  const what = `${surface} under ${text}`
  const all = shown(frames, [surface, text])
  expect(frames.length, `${what}: frames swept`).toBeGreaterThan(1)
  const end = frames.at(-1)!
  expect([end.at[surface], end.at[text]].map(Math.round), `${what}: where it ends; ${all}`).toEqual(coming ? [1, 1] : [0, 0])
  const bare = frames.find((f) => f.at[text] > SLACK && f.at[surface] < 1 - SLACK)
  expect(bare, `${what}: text over a see-through surface at ${bare?.t} ms; ${all}`).toBeUndefined()
}

// What lies under a moving part stays faint while the part is over it.
export function expectFaintUnder({ frames }: Swept, over: string, under: string): void {
  const all = shown(frames, [over, under])
  expect(frames.some((f) => f.at[over] === 1), `${over}: ever over it; ${all}`).toBe(true)
  const crossed = frames.find((f) => f.at[over] === 1 && f.at[under] > CROSS_FAINT + SLACK)
  expect(crossed, `${under} reads under ${over} at ${crossed?.t} ms; ${all}`).toBeUndefined()
}
