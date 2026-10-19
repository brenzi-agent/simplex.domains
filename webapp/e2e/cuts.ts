import type { Page } from "@playwright/test"
import { AXIS_MS } from "../src/motion-values.ts"

// What the page does that a person sees as a cut rather than motion: content shown and gone within a blink, content
// that appears or goes without easing, a height that jumps for one frame or snaps to a new one, a layout jump, a scroll
// jump, a view transition the browser refused. While a view transition runs, the browser draws the page from its
// pictures, so what changes under it is no cut.
export interface Cut { kind: "flash" | "cut-in" | "cut-out" | "spike" | "jump" | "shift" | "scroll-jump" | "refused" | "mid-motion" | "misplaced" | "clipped" | "stale" | "rebuilt" | "mark"; what: string; step: string }
export interface Transition { types: string[]; groups: string[]; animations: string[] }

// Runs in the page before the app, through addInitScript; it records into window.__cuts.
export function recordCuts(): void {
  type Seen = Element & { wasVisible?: boolean; fade?: Animation; misplaced?: boolean; clipped?: boolean }
  type Raw = { kind: string; what: string; t: number }
  const cuts: Raw[] = []
  const transitions: { types: string[]; groups: string[]; animations: string[] }[] = []
  const w = window as unknown as { __cuts: Raw[]; __mark: (label: string) => void; __transitions: typeof transitions; __lastTransition: ViewTransition | null }
  w.__cuts = cuts
  w.__transitions = transitions
  w.__mark = (label) => cuts.push({ kind: "mark", what: label, t: performance.now() })
  // each view transition from its start to a frame after its end, when the page is drawn as it is again
  const periods: [number, number][] = []
  const drawnByTransition = (t = performance.now()) => periods.some(([from, to]) => t >= from && t <= to + 20)
  // a transition skipped for a newer one is followed by that one within this long
  const SUPERSEDED_MS = 100
  const start = document.startViewTransition?.bind(document)
  if (start) {
    document.startViewTransition = ((arg: ViewTransitionUpdateCallback | StartViewTransitionOptions) => {
      const shown = document.querySelector("body > main:not(.pending)")
      const under = shown?.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && !a.pending && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)
        && Number(a.effect?.getComputedTiming().localTime ?? 0) >= Number(a.effect?.getTiming().delay ?? 0)) ?? []
      if (under.length) cuts.push({ kind: "mid-motion", what: under.map((a) => describe((a.effect as KeyframeEffect).target!)).join(" | "), t: performance.now() })
      const t = start(arg)
      w.__lastTransition = t
      const period: [number, number] = [performance.now(), Infinity]
      periods.push(period)
      const entry = { types: typeof arg === "function" ? [] : [...(arg.types ?? [])], groups: [] as string[], animations: [] as string[] }
      transitions.push(entry)
      t.ready.then(() => {
        // a part on one side only has no group animation, only its picture's
        entry.groups = [...new Set(document.getAnimations().map((a) => /^::view-transition-(?:group|old|new)\((.+)\)$/.exec((a.effect as KeyframeEffect | null)?.pseudoElement ?? "")?.[1])
          .filter((name): name is string => name !== undefined))]
        entry.animations = document.getAnimations().filter((a) => a instanceof CSSAnimation && (a.effect as KeyframeEffect | null)?.pseudoElement)
          .map((a) => `${(a.effect as KeyframeEffect).pseudoElement} ${(a as CSSAnimation).animationName}`)
      }, (e: Error) => {
        const at = transitions.length
        if (e.name !== "AbortError") cuts.push({ kind: "refused", what: `${e.name}: ${e.message}`, t: performance.now() })
        else setTimeout(() => { if (transitions.length === at) cuts.push({ kind: "refused", what: `skipped: ${e.message}`, t: performance.now() }) }, SUPERSEDED_MS)
      })
      void t.finished.catch(() => undefined).finally(() => { period[1] = performance.now() })
      return t
    }) as typeof document.startViewTransition
  }
  const describe = (n: Element) => `${n.tagName.toLowerCase()}.${[...n.classList].join(".")} "${(n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50)}"`
  const visible = (n: Element) => {
    if (!n.isConnected) return false
    const r = n.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(n)
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && !n.closest("[hidden], .sr-only")
  }
  // something on the way from the node up to the page is fading it in; a height easing alone does not soften what appears
  // A fade is one with time to be seen: a fade of a few milliseconds is a cut, whatever its keyframes say.
  const MIN_FADE_MS = 80
  const fading = (x: Animation) => ((x.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "opacity" in k) ?? false)
    && Number(x.effect?.getComputedTiming().activeDuration ?? 0) >= MIN_FADE_MS
  const easing = (n: Element) => {
    for (let a: Element | null = n; a && a !== document.body; a = a.parentElement) {
      if (a.getAnimations().some((x) => x.playState === "running" && fading(x))) return true
    }
    return false
  }
  const lasts = (x: Animation) => Number(x.effect?.getComputedTiming().activeDuration ?? 0) >= MIN_FADE_MS
  const moves = (x: Animation) => lasts(x) && ((x.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "translate" in k || "scale" in k || "height" in k) ?? false)
  const sameBox = (a: DOMRect, b: DOMRect) => Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
  const like = (o: Element, n: Element) => o.tagName === n.tagName && (n.classList.length === 0 ? o.classList.length === 0 : [...n.classList].some((c) => o.classList.contains(c)))
  const ownText = (n: Element) => [...n.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent).join("").trim()
  const shown = (color: string) => color !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(color)
  const running = (n: Element) => n.getAnimations().filter((x) => x.playState === "running")
  const SHARED_PARTS = ".order-name, .summary, .crumbs, .cols > .panel:first-child"

  const boxFade = (x: Animation) => (x.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "backgroundColor" in k || "borderColor" in k || "boxShadow" in k) ?? false
  const drawsBox = (n: Element) => {
    if (n instanceof SVGElement || n.matches("img, canvas, video")) return true
    if (running(n).some((x) => boxFade(x) && !lasts(x))) return true
    const s = getComputedStyle(n)
    const border = (["Top", "Right", "Bottom", "Left"] as const).some((side) => parseFloat(s[`border${side}Width`]) > 0 && shown(s[`border${side}Color`]))
    const shadow = (s.boxShadow.match(/rgba?\([^)]*\)/g) ?? []).some(shown)
    return shown(s.backgroundColor) || s.backgroundImage !== "none" || border || shadow
  }
  const paints = (n: Element) => ownText(n) !== "" || (drawsBox(n) && !running(n).some((x) => boxFade(x) && lasts(x)))
  const arrives = (n: Element): boolean => {
    if (running(n).some(fading)) return true
    const box = n.getBoundingClientRect()
    const olds = [...document.querySelectorAll(".page-leaving *")]
    if (running(n).some(moves) && olds.some((o) => like(o, n))) return true
    if (olds.some((o) => o.tagName === n.tagName && o.textContent === n.textContent && sameBox(o.getBoundingClientRect(), box))) return true
    const twin = olds.find((o) => o.tagName === n.tagName && sameBox(o.getBoundingClientRect(), box))
    if (paints(n) && !(twin && ownText(twin) === ownText(n) && (!drawsBox(n) || drawsBox(twin)))) return false
    const parts = [...n.children].filter((c) => visible(c) || running(c).some(fading))
    return parts.length > 0 && parts.every(arrives)
  }
  const addedAt = new Map<Element, number>()
  let userAt = -Infinity
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    addEventListener(type, () => {
      userAt = performance.now()
      // a test's click scrolls its target into view just before pressing it, as a person would scroll to it
      for (let i = cuts.length - 1; i >= 0; i--) if (cuts[i].kind === "scroll-jump" && userAt - cuts[i].t < 1000) cuts.splice(i, 1)
    }, true)
  }
  const watch = new MutationObserver((records) => {
    const now = performance.now()
    // a node taken out and put back in the same change stays on screen: it does not come in
    const moved = new Set(records.flatMap((r) => [...r.removedNodes]))
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof Element) || moved.has(n)) continue
        addedAt.set(n, now)
        const [before, beforeWhole, beforeAt] = [shownText, shownWhole, shownAt]
        // checked a frame later, when its own easing has started
        requestAnimationFrame(() => {
          if (!n.isConnected || n.closest(".outgoing, .pending, .page-leaving") || !visible(n)) return
          if (n.matches("main") && steadyText(n) === before) {
            if (location.href === beforeAt && n.textContent === beforeWhole) cuts.push({ kind: "rebuilt", what: describe(n), t: now })
            return
          }
          if (drawnByTransition(now)) return
          // content identical to what fades out over it shows no cut
          const twin = [...(n.parentElement?.querySelectorAll(":scope > .outgoing") ?? [])].some((o) => o.textContent === n.textContent)
          if (!twin && !easing(n) && !arrives(n)) cuts.push({ kind: "cut-in", what: describe(n), t: now })
        })
      }
      for (const n of r.removedNodes) {
        if (!(n instanceof Element) || !(n as Seen).wasVisible) continue
        const at = addedAt.get(n)
        // checked once this task is over: a node moved elsewhere is still in the page
        queueMicrotask(() => {
          if (n.isConnected || drawnByTransition(now)) return
          // a page swapped for the same page without a transition is no change; any other page swapped without one is a cut
          if (n.matches("main")) {
            const shown = document.querySelector("body > main:not(.pending)")
            if (shown?.textContent !== n.textContent) cuts.push({ kind: "cut-out", what: describe(n), t: performance.now() })
            return
          }
          // a popup closing gives way to one opened at once, which takes over from its opacity
          if (n.matches(".modal-overlay.closing") && document.querySelector(".modal-overlay:not(.closing)")) return
          // A fading layer is removed once its fade is over; cut off before its end, it is a cut. The fade is read as it
          // stands at the removal, by time, not by its eased progress, which a fade that holds on and goes late keeps low.
          if (n.matches(".outgoing, .modal-overlay.closing")) {
            const fade = (n as Seen).fade
            const length = Number(fade?.effect?.getComputedTiming().duration ?? 0)
            const done = fade && length ? Number(fade.currentTime ?? length) / length : 1
            if (done < 0.9) cuts.push({ kind: "cut-out", what: describe(n), t: now })
          } else if (at !== undefined && now - at < 400) cuts.push({ kind: "flash", what: describe(n), t: now })
          else cuts.push({ kind: "cut-out", what: describe(n), t: now })
        })
      }
    }
  })
  const steadyText = (root: Element) => {
    let out = ""
    const walk = (n: Node) => {
      if (n instanceof Element && (n.classList.contains("outgoing") || n.getAnimations().some((a) => a.playState === "running" && fading(a)))) return
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent
      n.childNodes.forEach(walk)
    }
    walk(root)
    return out
  }
  let shownText: string | null = null
  let shownWhole: string | null = null
  let shownAt = location.href
  // A page shown again after another took its place is a stale page drawn.
  const replaced = new WeakSet<Element>()
  let lastShown: Element | null = null
  const sample = () => {
    const shown = document.querySelector("body > main:not(.pending)")
    shownText = shown ? steadyText(shown) : null
    shownWhole = shown?.textContent ?? null
    shownAt = location.href
    if (shown !== lastShown) {
      if (lastShown) replaced.add(lastShown)
      if (shown && replaced.has(shown)) cuts.push({ kind: "stale", what: describe(shown), t: performance.now() })
      lastShown = shown
    }
    // which nodes were visible before each frame, for removals
    for (const n of document.querySelectorAll("main *, header *, .modal-overlay, .modal-overlay *")) {
      if (n.children.length <= 40) (n as Seen).wasVisible = visible(n)
    }
    // each fading layer's fade, to read where it stands when the layer goes
    for (const n of document.querySelectorAll(".outgoing, .modal-overlay.closing")) (n as Seen).fade ??= n.getAnimations().find(fading)
    const clips = (n: Element) => running(n).some((x) => (x.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "clipPath" in k) ?? false)
    const moved = (n: Element) => running(n).some((x) => (x.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "translate" in k) ?? false)
    for (const n of document.querySelector(".page-leaving") ? document.querySelectorAll<Seen>("body > main .live") : []) {
      if (n.clipped || !clips(n) || ![...n.querySelectorAll(SHARED_PARTS)].some(moved)) continue
      n.clipped = true
      cuts.push({ kind: "clipped", what: describe(n), t: performance.now() })
    }
    for (const n of document.querySelectorAll<Seen>(".outgoing")) {
      if (n.misplaced || getComputedStyle(n).position === "absolute") continue
      n.misplaced = true
      cuts.push({ kind: "misplaced", what: describe(n), t: performance.now() })
    }
    requestAnimationFrame(sample)
  }
  addEventListener("DOMContentLoaded", () => {
    watch.observe(document.body, { childList: true, subtree: true })
    requestAnimationFrame(sample)
  })
  // A height that jumps for a frame and comes back, or snaps to a new one in a frame with no easing to carry it. Read in a
  // resize observer made after the app's own, which runs after it in the same frame: what this reads is what is painted.
  // An easing moves a height by less than a third of its change in a frame; a window resized moves it at once.
  const SNAP_PX = 60
  let resizedAt = -Infinity
  addEventListener("resize", () => { resizedAt = performance.now() })
  const easingHeight = (n: Element) => n.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => "height" in k))
  addEventListener("load", () => {
    // each observed node's recent heights, by time
    const heights = new WeakMap<Element, { h: number; t: number }[]>()
    const heightAt = (n: Element, t: number) => [...(heights.get(n) ?? [])].reverse().find((s) => s.t <= t)?.h
    const sizes = new ResizeObserver((entries) => {
      const now = performance.now()
      const stepped: { node: Element; from: { h: number; t: number }; h: number }[] = []
      for (const e of entries) {
        if (!e.target.isConnected) continue
        const before = heights.get(e.target) ?? []
        const seen = [...before, { h: Math.round(e.target.getBoundingClientRect().height), t: now }].slice(-10)
        heights.set(e.target, seen)
        // a node taken out of the page, or a page not yet shown, is not laid out where it will be
        if (before.length && e.target.isConnected && !e.target.matches(".pending")) stepped.push({ node: e.target, from: before[before.length - 1], h: seen[seen.length - 1].h })
        const last3 = seen.slice(-3)
        if (last3.length < 3 || now - last3[0].t > 100 || drawnByTransition(now)) continue
        const [a, b, c] = last3.map((s) => s.h)
        if (Math.abs(b - a) > 8 && Math.abs(c - a) < Math.abs(b - a) / 2) cuts.push({ kind: "spike", what: `${describe(e.target)} ${a}→${b}→${c}`, t: now })
      }
      if (now - resizedAt < 500 || drawnByTransition(now)) return
      // What the outermost parts easing inside a node moved since the node last moved moves the node too; the rest of
      // its step is its own.
      for (const { node, from, h } of stepped) {
        if (easingHeight(node)) continue
        const inside = [...node.querySelectorAll(".live")].filter(easingHeight)
        const carried = inside.filter((inner) => !inside.some((mid) => mid !== inner && mid.contains(inner)))
          .reduce((sum, inner) => sum + Math.round(inner.getBoundingClientRect().height) - (heightAt(inner, from.t) ?? Math.round(inner.getBoundingClientRect().height)), 0)
        const step = h - from.h
        // a page held at the window's height does not move with what eases inside it
        if (Math.abs(step) <= SNAP_PX || Math.abs(step - carried) <= SNAP_PX) continue
        // WebKit can run this observer before the app's in a frame, so the app may still hold the node at its old
        // height before the frame is painted: a jump is one the next frame still shows, with no easing carrying it
        requestAnimationFrame(() => {
          const shown = Math.round(node.getBoundingClientRect().height)
          if (Math.abs(shown - h) < 2 && !easingHeight(node) && ![...node.querySelectorAll(".live")].some(easingHeight)) {
            cuts.push({ kind: "jump", what: `${describe(node)} ${step > 0 ? "+" : ""}${step}px, ${carried}px of it carried`, t: now })
          }
        })
      }
    })
    const observe = (root: ParentNode) => root.querySelectorAll(".live, body > main").forEach((n) => sizes.observe(n))
    observe(document)
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) { if (n.matches(".live, body > main")) sizes.observe(n); observe(n) }
    }).observe(document.body, { childList: true, subtree: true })
  })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { hadRecentInput: boolean; value: number; sources?: { node?: Node | null }[] })[]) {
        const moved = (e.sources ?? []).map((s) => s.node instanceof Element ? describe(s.node) : "").filter(Boolean).join(" | ")
        if (!drawnByTransition(e.startTime)) cuts.push({ kind: e.hadRecentInput ? "input-shift" : "shift", what: `${e.value} ${moved}`, t: e.startTime })
      }
    }).observe({ type: "layout-shift", buffered: true })
  } catch {
    // Firefox has no layout-shift entries; the other records still apply there
  }
  let lastY = 0
  addEventListener("scroll", () => {
    const now = performance.now()
    // a page opened goes to its top under its view transition
    if (Math.abs(scrollY - lastY) > 40 && now - userAt > 1000 && !drawnByTransition(now)) cuts.push({ kind: "scroll-jump", what: `${lastY} to ${scrollY}`, t: now })
    lastY = scrollY
  }, true)
}

// the smallest layout shift a person can see, as a share of the viewport
const SEEN_SHIFT = 0.001
const EASING_SHIFTS = 3

export const markStep = (page: Page, step: string) => page.evaluate((s) => (window as unknown as { __mark: (s: string) => void }).__mark(s), step)

// A run of three or more shifts within one easing's time is a height easing, not a jump; a lone shift that rounds to nothing is a subpixel settling.
export async function takeCuts(page: Page): Promise<Cut[]> {
  const raw = await page.evaluate(() => (window as unknown as { __cuts: { kind: string; what: string; t: number }[] }).__cuts.splice(0))
  const shifts = raw.filter((c) => c.kind === "shift" || c.kind === "input-shift").map((c) => c.t)
  const easing = (t: number) => shifts.filter((other) => Math.abs(other - t) <= AXIS_MS).length >= EASING_SHIFTS
  let step = "load"
  const out: Cut[] = []
  for (const c of raw) {
    if (c.kind === "mark") step = c.what
    else if (c.kind === "shift" && (easing(c.t) || parseFloat(c.what) < SEEN_SHIFT)) continue
    else if (c.kind !== "input-shift") out.push({ kind: c.kind as Cut["kind"], what: c.what, step })
  }
  return out
}

// The view transitions run since the last call.
export const takeTransitions = (page: Page) => page.evaluate(() => (window as unknown as { __transitions: Transition[] }).__transitions.splice(0))
