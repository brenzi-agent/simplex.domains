// The page's frame: theme switch and navigation between views; index.html draws the header and footer.
import { alertBox, btn, el, icon, type Kid, liveRegion, refill, type Tone, waitOut } from "../dom.ts"
import type { IconName } from "../icons.ts"
import type { Hold } from "../screens/hold.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { secondsLeft } from "./hold.ts"
import { fitHeight, leaveTrack, placeOnTrack, type TrackStep } from "./track.ts"

export const WEFUNDER_URL = "https://wefunder.com/simplex.chat?utm_source=domains"
export const CONTACT_EMAIL = "chat@simplex.chat"
export const INVEST_AMOUNT = "$500"

let rerender: () => void = () => undefined

export const setRenderer = (render: () => void) => { rerender = render }

let route = 0
const leaving: (() => void)[] = []
const dropping: (() => void)[] = []
let redrawing = false
// the route the screen on show was drawn on; a redraw of the same page carries it to the redrawn route
let drawnRoute = -1
let shownKind: string | null = null
// the screen in view: the track keeps the purchase steps beside it, out of reach
let shownScreen: HTMLElement | null = null
let screenStop: AbortController | null = null
// nodes a reader types into, kept for the route so a redraw moves them rather than rebuilding them
const keptNodes = new Map<string, HTMLElement>()

// A new route ends the last one's polls and timers: async work checks its token with isRoute before drawing.
export function nextRoute(): void {
  leaving.splice(0).forEach((f) => f())
  const samePage = redrawing && drawnRoute === route
  route += 1
  if (samePage) drawnRoute = route
  else {
    dropping.splice(0).forEach((f) => f())
    keptNodes.clear()
    screenStop?.abort()
    screenStop = null
    // the last screen stays in sight, out of reach, until the new route draws
    frame().inert = true
  }
}

export const isRedraw = () => drawnRoute === route

export const isRoute = (token: number) => token === route
export const currentRoute = () => route

export const whenLeaving = (f: () => void) => { leaving.push(f) }

// once the page is left for another, rather than drawn again, as its kept nodes are dropped
export const whenDropped = (f: () => void) => { dropping.push(f) }

const nextAt = () => Math.max(-1, ...Object.keys(session.scrolled()).map(Number)) + 1
let historyAt = typeof history.state?.at === "number" ? history.state.at as number : nextAt()
if (history.state?.at !== historyAt) history.replaceState({ ...history.state, at: historyAt }, "")
history.scrollRestoration = "manual"
// a tab a phone puts away may be dropped without unloading, so the place is kept as it is hidden too
const keepScrolled = () => session.setScrolled(historyAt, leftAt())
addEventListener("pagehide", keepScrolled)
document.addEventListener("visibilitychange", () => { if (document.hidden) keepScrolled() })
// a page reached by Back or Forward rather than by a link, until it is drawn
let popped = false
export const throughHistory = () => popped
let scrollTarget: number | null = session.scrolled()[historyAt] ?? null
const leftAt = () => scrollTarget ?? scrollY
// the entry this document was loaded at; Back to an entry before it would load an earlier document again
const loadedAt = historyAt
let landing: string | null = null
export const historyPlace = () => historyAt

// Opens `url` after the entry at `at`, so Back lands there once; where that would leave the document, this entry becomes `back`.
export function goFrom(at: number, back: string, url: string): void {
  if (at < loadedAt || at >= historyAt) {
    history.replaceState(history.state, "", back)
    return go(url)
  }
  keepScrolled()
  landing = url
  history.go(at - historyAt)
}

// false when the move was a jump back that opened its page itself
export function historyMoved(e: PopStateEvent): boolean {
  if (landing !== null && typeof e.state?.at === "number") {
    const url = landing
    landing = null
    historyAt = e.state.at as number
    // the entry landed on keeps the place it was left at
    scrollTarget = session.scrolled()[historyAt] ?? 0
    go(url)
    return false
  }
  keepScrolled()
  if (typeof e.state?.at !== "number") {
    historyAt = nextAt()
    history.replaceState({ ...e.state, at: historyAt }, "")
    popped = false
    scrollTarget = 0
    return true
  }
  const at = e.state.at as number
  popped = true
  historyAt = at
  scrollTarget = session.scrolled()[at] ?? 0
  return true
}

export function go(url: string): void {
  keepScrolled()
  historyAt += 1
  history.pushState({ at: historyAt }, "", url)
  popped = false
  scrollTarget = 0
  rerender()
}

// a search for the name, still opened from the app when it was: a name found there registers to the app's wallet
export const searchLink = (label: string, appOwner: string | null) =>
  `/#/?${new URLSearchParams({ name: label, ...(appOwner ? { owner: appOwner } : {}) })}`

// for a page that sends the buyer elsewhere: replacing the entry keeps Back and Forward usable
export function redirect(url: string): void {
  history.replaceState({ at: historyAt }, "", url)
  rerender()
}

export function refresh(): void {
  redrawing = true
  try {
    rerender()
  } finally {
    redrawing = false
  }
}

export type Builder<S> = (state: S, signal: AbortSignal) => HTMLElement
interface ScreenHead { title: Kid; lead?: Kid; back?: string }
interface Outcome { tone: Tone; icon: IconName; title: string; text: Kid; action?: Node | null; reference?: string; extra?: Kid; back?: string }

export function kept<T extends HTMLElement>(key: string, make: () => T): T {
  const known = keptNodes.get(key)
  if (known) return known as T
  const made = make()
  keptNodes.set(key, made)
  return made
}

// a live region stays one node for the route, so a screen reader hears what each draw puts in it
export const keptLive = (key: string, cls: string | undefined, ...kids: Kid[]) => refill(kept(key, () => liveRegion(cls)), ...kids)

const LOADING = "loading"
let fontsAwaited = false
// the key of a control a redraw turned off, whose focus dropped to the page: a later redraw that offers it gives it back
let lostKey: string | null = null

export function draw(kind: string, build: (signal: AbortSignal) => HTMLElement, step: TrackStep | null = null): void {
  const main = frame()
  showConnection()
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] as const : null
  const focusKey = active === null || active === document.body ? lostKey : active.dataset.focus ?? null
  const first = shownKind === null
  const redrawn = kind === shownKind && drawnRoute === route
  // the heading the last draw focused is replaced with its screen, so the redrawn screen's heading takes focus
  const toHeading = !redrawn || (active !== null && active === shownScreen?.querySelector("h1"))
  screenStop?.abort()
  screenStop = new AbortController()
  const next = build(screenStop.signal)
  if (step === null) leaveTrack(main, next)
  else placeOnTrack(main, step, next)
  if (!redrawn) holdSpacers(next)
  // the first page opens anew once the fonts its layout asked for have loaded; a face a later change asks for moves nothing
  if (!fontsAwaited && kind !== LOADING) void document.fonts.ready.then(reopen)
  fontsAwaited ||= kind !== LOADING
  shownScreen = next
  main.inert = false
  shownKind = kind
  drawnRoute = route
  popped = false
  document.title = titleOf(next)
  lostKey = null
  if (!first) settleFocus(active, caret, toHeading, focusKey)
  // the place a page was left at is kept for the page itself, not for the loading line before it
  if (scrollTarget !== null && kind !== LOADING) {
    scrollTo(0, scrollTarget)
    scrollTarget = null
  }
}

const keyed = (key: string | null | undefined) => key ? shownScreen?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]:not([disabled])`) : null

export const focusOn = (key: string) => keyed(key)?.focus({ preventScroll: true })

export function focusHeading(): void {
  const heading = shownScreen?.querySelector<HTMLElement>("h1")
  if (!heading) return
  heading.tabIndex = -1
  heading.focus({ preventScroll: true })
}

// A new kind of screen, or one whose heading had focus, gives its heading focus; the same kind drawn again gives it back
// to the keyed control it was on, or leaves it where it is.
function settleFocus(active: HTMLElement | null, caret: readonly [number | null, number | null] | null, toHeading: boolean, focusKey: string | null): void {
  if (active?.isConnected && shownScreen?.contains(active)) {
    active.focus({ preventScroll: true })
    if (caret && active instanceof HTMLInputElement) active.setSelectionRange(caret[0], caret[1])
    return
  }
  // focus on the header, the footer or a dialog stays there; focus that was in main, even in a screen now inert, goes to the new heading
  if (active && active !== document.body && active.isConnected && !active.closest("body > main")) return
  if (toHeading) return focusHeading()
  const same = keyed(focusKey)
  if (!same) {
    lostKey = focusKey
    return
  }
  // the control found again, or the answer that took its key, stays in sight, as a phone may have it below the fold
  same.focus({ preventScroll: true })
  same.scrollIntoView({ block: "nearest" })
}

const SITE_TITLE = "SimpleX names"
const titleOf = (next: HTMLElement) => {
  const heading = next.querySelector("h1")?.textContent?.trim()
  return heading ? `${heading} · ${SITE_TITLE}` : SITE_TITLE
}

const screenHead = (title: Kid, back: string | undefined) =>
  el("div", { class: "screen-head" }, back ? el("a", { class: "back", href: back, "aria-label": "Back", title: "Back" }, icon("back")) : null, el("h1", {}, title))

export function screen(head: ScreenHead, ...body: Kid[]): HTMLElement {
  return el("section", { class: "screen" },
    screenHead(head.title, head.back),
    head.lead ? el("p", { class: "lead" }, head.lead) : null,
    ...body)
}

// A purchase step or an outcome fills the window, its content between two spacers; a list starts under the header, so rows never shift.
export const asStep = (screen: HTMLElement) => { screen.classList.add("step"); screen.replaceChildren(kept("step-top", spacer), ...screen.children, spacer()); return screen }
export const spacer = () => el("div", { class: "vspace" })

export function outcome(o: Outcome): HTMLElement {
  return el("section", { class: "screen outcome" },
    screenHead(o.title, o.back),
    alertBox(o.tone, o.icon, null, o.text),
    o.extra ?? null,
    o.action ?? null,
    o.reference ? referenceLine(o.reference) : null)
}

// The spacers above a step's or the home's content, kept for the route, hold where it opened; what changes moves only what is below.
function holdSpacers(screen: HTMLElement): void {
  const spacers = [...screen.querySelectorAll<HTMLElement>(":scope > .vspace:not(:last-child)")]
  for (const spacer of spacers) spacer.removeAttribute("style")
  spacers.map((spacer) => `0 0 ${spacer.getBoundingClientRect().height}px`).forEach((flex, i) => { spacers[i].style.flex = flex })
}

const LIMITED = "Too many orders were tried from here."

export function limitScreen(hold: Hold | null, again: () => void, back: string, signal: AbortSignal): HTMLElement {
  const line = el("span", {}, `${LIMITED} Nothing was charged.`)
  const tryAgain = btn("Try again", "block", again)
  tryAgain.disabled = hold !== null
  const shown = outcome({ tone: "warn", icon: "clock", title: "Too many attempts", text: line, action: tryAgain, back })
  // the count goes in once the line is in its notice, where its spoken copy goes beside it
  if (hold) waitOut(line, Math.max(1, secondsLeft(hold)), (left) => `${LIMITED} Try again in ${left}.`, () => undefined, signal)
  return shown
}

export const referenceLine = (reference: string) => el("p", { class: "note ref" }, "Reference ", el("span", { class: "mono" }, reference))

// shown only before a document's first draw, placed as the screen after it will be, so its heading stays put
export function drawLoading(title: string, place = (screen: HTMLElement) => screen): void {
  if (frame().childElementCount) return
  draw(LOADING, () => place(el("section", { class: "screen" }, el("h1", {}, title))))
}

export const isDark = () => document.documentElement.classList.contains("dark")

// The browser's own bars, as a phone's or an installed app's, in the page's background for the theme on screen, which
// the reader may have chosen over the one their system prefers.
function paintBars(): void {
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--page-color").trim()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = ground
}

function toggleTheme(): void {
  const dark = !isDark()
  store.setTheme(dark ? "dark" : "light")
  document.documentElement.classList.toggle("dark", dark)
  paintBars()
}

export const OFFLINE_NOTE = "You are offline. Searches, payments and order updates need the connection."

// After the footer and counted in the frame, so the footer's end scrolls clear of the note. The note stays in place and
// only its words change, which a screen reader announces where it may miss a note being shown.
const offlineText = el("span", {})
const offline = el("div", { class: "offline", role: "status" }, el("div", { class: "offline-note" }, icon("offline"), offlineText))
// The frame and track take the note's height before it joins the flow: a layout taller than the window gets a scrollbar in Firefox, which can rewrap lines and stay.
function showConnection(): void {
  const text = navigator.onLine ? "" : OFFLINE_NOTE
  if (offlineText.textContent === text) return
  offline.style.position = "absolute"
  offlineText.textContent = text
  fitFrame()
  fitHeight(0)
  offline.style.removeProperty("position")
}

// Checked again whenever the page is drawn or looked at, as Firefox does not always tell a page opened offline that
// the network is back.
for (const event of ["online", "offline", "focus"]) addEventListener(event, showConnection)
document.addEventListener("visibilitychange", showConnection)

// index.html draws the header and footer; the script wires the theme switch once
function frame(): HTMLElement {
  const main = document.querySelector<HTMLElement>("body > main")!
  if (document.body.dataset.framed) return main
  document.body.dataset.framed = "1"
  document.querySelector(".theme-switch")!.addEventListener("click", toggleTheme)
  paintBars()
  document.body.append(offline)
  measureFrame()
  return main
}

// The header's, footer's and offline note's height, which wrap on a narrow screen, so the home fills what is left of the window. Rounded
// up, as the track rounds its height up too and a fraction more would scroll the page.
const frameParts = () => [...document.querySelectorAll<HTMLElement>("body > header, body > footer, body > .offline")]
const fitFrame = () => document.documentElement.style.setProperty("--frame-h", `${Math.ceil(frameParts().reduce((h, p) => h + p.getBoundingClientRect().height, 0))}px`)

function measureFrame(): void {
  const resized = new ResizeObserver(fitFrame)
  for (const part of frameParts()) resized.observe(part)
  fitFrame()
  // A window resized opens the screen in view anew, and again once the fonts its new layout asked for have loaded; a
  // scrollbar coming or going, or the offline note, leaves the window as it was.
  const sized = () => `${innerWidth}x${innerHeight}`
  let size = sized()
  addEventListener("resize", () => { if (sized() !== size) { size = sized(); reopen(); void document.fonts.ready.then(reopen) } })
}

const reopen = () => { fitFrame(); if (shownScreen) holdSpacers(shownScreen) }
