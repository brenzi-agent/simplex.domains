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

// The CSP refuses style attributes but not the style object, so styles are set through it.
export function fitHeight(ms: number): void {
  shownHeight = slideHeight()
  track.style.setProperty("--slide", `${ms}ms`)
  track.style.height = shownHeight > 0 ? `${shownHeight}px` : ""
}

// A slide whose content changes size resizes the track at once; the observer's first report, the height just set, would cut its transition short.
const resized = new ResizeObserver(() => { if (slideHeight() !== shownHeight) fitHeight(0) })

function moveTrack(smooth: boolean): void {
  const ms = slideMs(smooth)
  rail.style.setProperty("--slide", `${ms}ms`)
  rail.style.transform = `translateX(-${index * 100}%)`
  fitHeight(ms)
}

export function placeOnTrack(main: HTMLElement, step: TrackStep, screen: HTMLElement): boolean {
  const mounted = main.firstChild === track
  const at = STEPS.indexOf(step)
  const adjacent = Math.abs(at - index) === 1
  if (!mounted) main.replaceChildren(track)
  slides[at].replaceChildren(screen)
  // a redraw of the step in view moves nothing, so a slide still on its way is not cut short
  if (mounted && at === index) return false
  // a step entered while the reader is below the track's top starts at its top
  const top = track.getBoundingClientRect().top
  if (mounted && top < 0) scrollBy({ top, behavior: "instant" })
  resized.disconnect()
  index = at
  slides.forEach((s, i) => { s.inert = i !== index })
  moveTrack(mounted && adjacent)
  resized.observe(slides[index])
  return mounted && adjacent
}

export function leaveTrack(main: HTMLElement, screen: HTMLElement): void {
  resized.disconnect()
  for (const s of slides) s.replaceChildren()
  main.replaceChildren(screen)
}
