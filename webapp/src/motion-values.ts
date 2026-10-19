// Motion values shared by the page and its tests, which import this module outside a browser.

// Firefox before 158 draws a frame from graphics memory not yet drawn into (bugzilla.mozilla.org 2066829), so it fades through.
export const FIREFOX_FIXED = 158
// the longest easing the page runs; its value matches --axis-ms in styles.css
export const AXIS_MS = 300

// A crossing: what goes gives way to what comes in its place. What goes dims to HELD while what comes rises to FAINT,
// then the two trade places at once, so in every frame one reads clearly, the other no more than FAINT, and together
// they never show less than HELD + FAINT. The values match --cross-ms, --cross-out and --cross-in in styles.css.
export const CROSS_MS = 160
export const CROSS_HELD = 0.6
export const CROSS_FAINT = 0.2
// the share of the crossing at which the two trade places
export const CROSS_SWAP = 0.5
const swapAt = `${CROSS_SWAP * 100}%`
// easings of an opacity from 1 to 0 and from 0 to 1, as linear() takes the progress from 0 to 1
export const CROSS_OUT = `linear(0, ${1 - CROSS_HELD} ${swapAt}, ${1 - CROSS_FAINT} ${swapAt}, 1)`
export const CROSS_IN = `linear(0, ${CROSS_FAINT} ${swapAt}, ${CROSS_HELD} ${swapAt}, 1)`

// Playwright sends this function into the page as source, so it takes the version as an argument rather than reading the constant.
export function viewTransitionsUsable(firefoxFixed: number): boolean {
  const typed = "startViewTransition" in document && typeof ViewTransition !== "undefined" && "types" in ViewTransition.prototype
  const gecko = CSS.supports("-moz-appearance", "none")
  return typed && (!gecko || Number(/Firefox\/(\d+)/.exec(navigator.userAgent)?.[1] ?? 0) >= firefoxFixed)
}

// A page change that scrolls the window by more than this share of its height pairs none of the pages' parts, which
// would cross the screen by the scroll.
const PAIRED_SCROLL_SHARE = 0.25
// a scroll of less than a pixel leaves everything where it was drawn
const STILL_SCROLL_PX = 1
export type Pairing = "all" | "card" | "none"
// What a page change pairs: everything when the window stays where it is, only the order's card and name when it
// scrolls a little, as each part would otherwise slide by the scroll, and nothing when it scrolls far.
export function pairingFor(scrollTo: number | null, scrolled: number, viewport: number): Pairing {
  if (scrollTo === null || Math.abs(scrollTo - scrolled) < STILL_SCROLL_PX) return "all"
  return Math.abs(scrollTo - scrolled) > viewport * PAIRED_SCROLL_SHARE ? "none" : "card"
}
