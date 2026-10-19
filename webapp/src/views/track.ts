// The purchase steps, from the search to the payment: slides on one rail that moves a step at a time, as the badges wizard does.
import { el, reducedMotion } from "../dom.ts"

const STEPS = ["search", "links", "code", "review", "payment"] as const
export type TrackStep = typeof STEPS[number]
// the badges wizard's slide (simplex-badge-service/web/src/main.ts:423)
const SLIDE_MS = 320

const slides = STEPS.map(() => el("div", { class: "slide" }))
const rail = el("div", { class: "rail" }, ...slides)
const track = el("div", { class: "track" }, rail)
let index = 0
let shownHeight = 0

const slideMs = (smooth: boolean) => smooth && !reducedMotion() ? SLIDE_MS : 0
const slideHeight = () => Math.ceil(slides[index].getBoundingClientRect().height)

function fitHeight(ms: number): void {
  shownHeight = slideHeight()
  track.setAttribute("style", shownHeight > 0 ? `--slide:${ms}ms;height:${shownHeight}px` : `--slide:${ms}ms`)
}

// A slide whose content grows or shrinks after it was placed resizes the track at once. The observer's first report
// is the height just set, and acting on it would cut that move's height transition short.
const resized = new ResizeObserver(() => { if (slideHeight() !== shownHeight) fitHeight(0) })

function moveTrack(smooth: boolean): void {
  const ms = slideMs(smooth)
  rail.setAttribute("style", `--slide:${ms}ms;transform:translateX(-${index * 100}%)`)
  fitHeight(ms)
}

/** Puts a purchase screen on its step; a move to the next or previous step slides, any other move is at once. */
export function placeOnTrack(main: HTMLElement, step: TrackStep, screen: HTMLElement): void {
  const mounted = main.firstChild === track
  const at = STEPS.indexOf(step)
  const adjacent = Math.abs(at - index) === 1
  if (!mounted) main.replaceChildren(track)
  slides[at].replaceChildren(screen)
  // a redraw of the step in view moves nothing, so a slide still on its way is not cut short
  if (mounted && at === index) return
  // a step entered while the reader is below the track's top starts at its top
  const top = track.getBoundingClientRect().top
  if (mounted && top < 0) scrollBy({ top, behavior: "instant" })
  resized.disconnect()
  index = at
  slides.forEach((s, i) => { s.inert = i !== index })
  moveTrack(mounted && adjacent)
  resized.observe(slides[index])
}

export function leaveTrack(main: HTMLElement, screen: HTMLElement): void {
  resized.disconnect()
  for (const s of slides) s.replaceChildren()
  main.replaceChildren(screen)
}
