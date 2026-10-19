// The page's frame: theme switch, popups, and navigation between views; index.html draws the header and footer.
import { alertBox, el, icon, type Kid, liveRegion, refill, type Tone } from "../dom.ts"
import type { IconName } from "../icons.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { leaveTrack, placeOnTrack, type TrackStep } from "./track.ts"

export const WEFUNDER_URL = "https://wefunder.com/simplex.chat?utm_source=domains"
export const CONTACT_EMAIL = "chat@simplex.chat"
export const INVEST_AMOUNT = "$500"

let rerender: () => void = () => undefined

export function setRenderer(render: () => void): void {
  rerender = render
}

let route = 0
const leaving: (() => void)[] = []
const dropping: (() => void)[] = []
// An open popup belongs to the route it was opened on; a redraw of the same page carries it to the redrawn route.
let popupRoute = -1
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
  const keepPopup = redrawing && popupRoute === route
  const samePage = redrawing && drawnRoute === route
  route += 1
  if (keepPopup) popupRoute = route
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

// drawing the same page again, as a redraw in place does without a new route
export const isRedraw = () => drawnRoute === route

export const isRoute = (token: number) => token === route
export const currentRoute = () => route

export function whenLeaving(f: () => void): void {
  leaving.push(f)
}

// once the page is left for another, rather than drawn again, as its kept nodes are dropped
export function whenDropped(f: () => void): void {
  dropping.push(f)
}

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
export function historyMoved(e: PopStateEvent): void {
  keepScrolled()
  if (typeof e.state?.at !== "number") {
    historyAt = nextAt()
    history.replaceState({ ...e.state, at: historyAt }, "")
    popped = false
    scrollTarget = 0
    return
  }
  const at = e.state.at as number
  popped = true
  historyAt = at
  scrollTarget = session.scrolled()[at] ?? 0
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

// the same page drawn again, keeping a popup open over it
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
interface Outcome { tone: Tone; icon: IconName; title: string; text: Kid; action?: Node | null; reference?: string; extra?: Kid }

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
// the key of a control a redraw turned off, whose focus dropped to the page: a later redraw that offers it gives it back
let lostKey: string | null = null

/** Builds the screen for `kind` and puts it on its purchase step, or swaps it in whole; the last screen's timers end with its signal. */
export function draw(kind: string, build: (signal: AbortSignal) => HTMLElement, step: TrackStep | null = null): void {
  const main = frame()
  // a popup opened on this page stays over its redraw; one that led to another page closes
  if (popupRoute !== route) closePopup(false)
  showConnection()
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] as const : null
  const focusKey = active === null || active === document.body ? lostKey : active.dataset.focus ?? null
  const first = shownKind === null
  // the heading the last draw focused is replaced with its screen, so the redrawn screen's heading takes focus
  const toHeading = kind !== shownKind || drawnRoute !== route || (active !== null && active === shownScreen?.querySelector("h1"))
  screenStop?.abort()
  screenStop = new AbortController()
  const next = build(screenStop.signal)
  if (step === null) leaveTrack(main, next)
  else placeOnTrack(main, step, next)
  shownScreen = next
  main.inert = document.querySelector(OVERLAY) !== null
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

function focusHeading(): void {
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
  // focus on the header, the footer or a popup stays there; focus that was in main, even in a screen now inert, goes to the new heading
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

export function screen(head: ScreenHead, ...body: Kid[]): HTMLElement {
  return el("section", { class: "screen" },
    head.back ? el("a", { class: "back", href: head.back }, icon("back"), "Back") : null,
    el("h1", {}, head.title),
    head.lead ? el("p", { class: "lead" }, head.lead) : null,
    ...body)
}

// the badges pattern: a heading, one notice, one action
export function outcome(o: Outcome): HTMLElement {
  return el("section", { class: "screen outcome" },
    el("h1", {}, o.title),
    alertBox(o.tone, o.icon, null, o.text),
    o.extra ?? null,
    o.action ?? null,
    o.reference ? el("p", { class: "note ref" }, "Reference ", el("span", { class: "mono" }, o.reference)) : null)
}

// shown only in a document that has drawn nothing yet, while its first read is on its way
export function drawLoading(title: string): void {
  if (frame().childElementCount) return
  draw(LOADING, () => el("section", { class: "screen" }, el("h1", {}, title)))
}

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark")
}

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

// Shown while the browser has no network, fixed over the page's foot.
function showConnection(): void {
  const shown = document.querySelector(".offline-note")
  if (navigator.onLine) return shown?.remove()
  if (shown) return
  document.body.append(el("div", { class: "offline-note", role: "status" }, icon("offline"), el("span", {}, OFFLINE_NOTE)))
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
  measureFrame()
  return main
}

// The header's and footer's height, which wrap on a narrow screen, so the home fills what is left of the window. Rounded
// up, as the track rounds its height up too and a fraction more would scroll the page.
function measureFrame(): void {
  const parts = [...document.querySelectorAll<HTMLElement>("body > header, body > footer")]
  const fit = () => document.documentElement.style.setProperty("--frame-h", `${Math.ceil(parts.reduce((h, p) => h + p.getBoundingClientRect().height, 0))}px`)
  const resized = new ResizeObserver(fit)
  for (const part of parts) resized.observe(part)
}

// Escape closes the popup, and Tab cycles within it
function popupKeys(e: KeyboardEvent): void {
  if (e.key === "Escape") return closePopup()
  const modal = document.querySelector<HTMLElement>(`${OVERLAY} .popup`)
  if (e.key !== "Tab" || !modal) return
  const focusable = [...modal.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input")]
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const inside = modal.contains(document.activeElement)
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault()
    first.focus()
  }
}

// where focus returns when the popup closes: the control that opened it, or the one drawn in its place
let opener: HTMLElement | null = null

const OVERLAY = ".modal-overlay"
let behindPopup: HTMLElement[] = []

export function popup(content: HTMLElement): void {
  closePopup()
  popupRoute = route
  const active = document.activeElement
  opener = active instanceof HTMLElement && active !== document.body ? active : null
  const overlay = el("div", { class: "modal-overlay", onclick: (e: Event) => { if (e.target === overlay) closePopup() } }, content)
  document.body.append(overlay)
  document.documentElement.classList.add("modal-open")
  content.setAttribute("aria-modal", "true")
  behindPopup = [...document.querySelectorAll<HTMLElement>("body > header.topbar, body > main, body > footer")].filter((n) => !n.inert)
  for (const node of behindPopup) node.inert = true
  // focus moves into the dialog; a popup with a field focuses that field itself afterwards
  content.querySelector<HTMLElement>("a[href], button:not([disabled]), input")?.focus()
  document.addEventListener("keydown", popupKeys)
}

// refocus false: the caller draws a new page and puts focus on it itself
export function closePopup(refocus = true): void {
  document.removeEventListener("keydown", popupKeys)
  const overlay = document.querySelector<HTMLElement>(OVERLAY)
  if (!overlay) return
  // a click on the backdrop has already moved focus to the page itself
  const hadFocus = overlay.contains(document.activeElement) || document.activeElement === document.body
  overlay.remove()
  document.documentElement.classList.remove("modal-open")
  for (const node of behindPopup) node.inert = false
  behindPopup = []
  // An opener the page redrew under the popup is found again by its data-focus key; failing that, the heading takes
  // focus, unless the redrawn page has already put focus somewhere of its own.
  const back = opener?.isConnected ? opener : refocus ? keyed(opener?.dataset.focus) : null
  back?.focus({ preventScroll: true })
  if (refocus && hadFocus && document.activeElement !== back) focusHeading()
  opener = null
}
