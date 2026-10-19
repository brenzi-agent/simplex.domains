// The page's frame: theme switch, popups, and navigation between views; index.html draws the header and footer.
import { el, icon } from "../dom.ts"
import * as focus from "../focus.ts"
import { dropWaitingPage, EASE, fadeIn, finishMotion, type Leave, live, moving, overlayIn, overlayOut, swapPage, syncList, TRANSIENT, transition, transitions, transitionsIdle } from "../motion.ts"
import { CROSS_MS } from "../motion-values.ts"
import type { Motion, PageMotion } from "../screens/machine.ts"
import { routes, type View } from "../screens/routes.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"

export const WEFUNDER_URL = "https://wefunder.com/simplex.chat?utm_source=domains"
export const CONTACT_EMAIL = "chat@simplex.chat"
export const INVEST_AMOUNT = "$500"
export const INVEST_LINE = `Invest ${INVEST_AMOUNT}+ in SimpleX Chat and get a free SimpleX name.`

let rerender: () => void = () => undefined

export function setRenderer(render: () => void): void {
  rerender = render
}

let route = 0
const leaving: (() => void)[] = []
// An open popup belongs to the route it was opened on; a redraw of the same page carries it to the redrawn route.
let popupRoute = -1
let redrawing = false
// the route the page on screen was drawn on; a redraw of the same page keeps keyboard focus where it was
let drawnRoute = -1
let routeView: View = "search"
let drawnView: View | null = null

// A new route ends the last one's polls and timers: async work checks its token with isRoute before drawing.
export function nextRoute(view: View): void {
  routeView = view
  leaving.splice(0).forEach((f) => f())
  const keepPopup = redrawing && popupRoute === route
  const samePage = redrawing && drawnRoute === route
  route += 1
  if (keepPopup) popupRoute = route
  if (samePage) drawnRoute = route
  else {
    focus.drop()
    shownStop?.abort()
    shownStop = null
  }
}

// drawing the same page again, as a redraw in place does without a new route
export const isRedraw = () => drawnRoute === route

export const isRoute = (token: number) => token === route
export const currentRoute = () => route

export function whenLeaving(f: () => void): void {
  leaving.push(f)
}

const nextAt = () => Math.max(-1, ...Object.keys(session.scrolled()).map(Number)) + 1
let historyAt = typeof history.state?.at === "number" ? history.state.at as number : nextAt()
if (history.state?.at !== historyAt) history.replaceState({ ...history.state, at: historyAt }, "")
history.scrollRestoration = "manual"
// a tab a phone puts away may be dropped without unloading, so the place is kept as it is hidden too
const keepScrolled = () => session.setScrolled(historyAt, leftAt())
addEventListener("pagehide", keepScrolled)
document.addEventListener("visibilitychange", () => { if (document.hidden) keepScrolled() })
// the way the last move through the history went, for the page it draws
type Way = "forward" | "back"
let popped: Way | null = null
export const throughHistory = () => popped !== null
let scrollTarget: number | null = session.scrolled()[historyAt] ?? null
const leftAt = () => scrollTarget ?? waitingPage?.scrollTo ?? scrollY
export function historyMoved(e: PopStateEvent): void {
  keepScrolled()
  if (typeof e.state?.at !== "number") {
    historyAt = nextAt()
    history.replaceState({ ...e.state, at: historyAt }, "")
    popped = null
    scrollTarget = 0
    return
  }
  const at = e.state.at as number
  popped = at < historyAt ? "back" : "forward"
  historyAt = at
  scrollTarget = session.scrolled()[at] ?? 0
}

export function go(url: string): void {
  keepScrolled()
  historyAt += 1
  history.pushState({ at: historyAt }, "", url)
  popped = null
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

export interface Built<S> { sections: Node[]; update: (state: S) => void }
export type Build<S> = (state: S, signal: AbortSignal) => Built<S>
let shownStop: AbortController | null = null

export function screens<S>(): (kind: string, state: S, build: Build<S>, toHeading?: boolean | null, motion?: Motion) => void {
  let shown: { kind: string; update: (state: S) => void; stop: AbortController } | null = null
  return (kind, state, build, toHeading = null, motion = "screen") => {
    if (shown !== null && shown.stop === shownStop && shown.kind === kind && isRedraw() && document.querySelector(SHOWN_PAGE) !== null) {
      shown.update(state)
      return void transitionsIdle().then(nameTab)
    }
    shownStop?.abort()
    const stop = new AbortController()
    const built = build(state, stop.signal)
    shown = { kind, update: built.update, stop }
    shownStop = stop
    page(built.sections, toHeading, motion === "in-place" ? "screen" : motion)
  }
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

// the note's height, for the room the foot makes for it
const noteRoom = new ResizeObserver(([entry]) => document.documentElement.style.setProperty("--offline-room", `${entry.borderBoxSize[0].blockSize}px`))

// Shown while the browser has no network, fixed over the page's foot, so nothing under it moves.
function showConnection(): void {
  const shown = document.querySelector<HTMLElement>(".offline-note:not(.closing)")
  if (navigator.onLine) {
    if (!shown) return
    noteRoom.unobserve(shown)
    if (!moving()) return shown.remove()
    shown.classList.add("closing")
    return overlayOut(shown, [...shown.children], () => shown.remove())
  }
  if (shown) return
  const note = el("div", { class: "offline-note", role: "status" }, icon("offline"), el("span", {}, OFFLINE_NOTE))
  document.body.append(note)
  noteRoom.observe(note)
  overlayIn(note, [...note.children])
}
// Checked again whenever the page is drawn or looked at, as Firefox does not always tell a page opened offline that
// the network is back.
for (const event of ["online", "offline", "focus"]) addEventListener(event, showConnection)
document.addEventListener("visibilitychange", showConnection)

const SHOWN_PAGE = "body > main:not(.pending)"

// index.html draws the header and footer; the script wires the theme switch once
function frame(): HTMLElement {
  const main = document.querySelector<HTMLElement>(SHOWN_PAGE)!
  if (document.body.dataset.framed) return main
  document.body.dataset.framed = "1"
  document.querySelector(".theme-switch")!.addEventListener("click", toggleTheme)
  paintBars()
  return main
}

let waitingPage: { main: HTMLElement; scrollTo: number | null } | null = null

const SITE_TITLE = "SimpleX names"
function nameTab(): void {
  const h1 = document.querySelector(`${SHOWN_PAGE} h1`)
  const heading = h1 ? [...h1.childNodes].filter((n) => !(n instanceof Element && n.classList.contains("outgoing"))).map((n) => n.textContent).join("").trim() : ""
  document.title = heading ? `${heading} · ${SITE_TITLE}` : SITE_TITLE
}

export function page(sections: Node[], toHeading: boolean | null = null, motion: PageMotion = "screen"): void {
  dropWaitingPage()
  if (waitingPage) {
    waitingPage.main.remove()
    scrollTarget ??= waitingPage.scrollTo
    waitingPage = null
  }
  const overlay = document.querySelector(OVERLAY)
  // a popup opened on this page stays over its redraw; one that led to another page closes
  const keep = overlay !== null && popupRoute === route
  if (overlay && !keep) closePopup(false)
  const samePage = isRedraw()
  const keepFocus = samePage && toHeading === null
  if (keepFocus) focus.keep(document.activeElement)
  const old = frame()
  showConnection()
  const main = el("main", {}, ...sections)
  const first = !old.childElementCount
  const filled = old.querySelector("[data-placeholder]") != null
  const arrived = old.querySelector('[data-placeholder=""]') != null
  // Firefox draws a part without the fade of what it is in, so a placeholder not yet fully faded in gives way as a first page does.
  const unseen = filled && [...old.querySelectorAll("[data-placeholder]")].some((n) => n.getAnimations().some((a) => a.playState !== "finished"))
  const change = samePage ? (filled ? "fill" : motion) : popped ?? (drawnView ? routes[drawnView][routeView] : motion)
  const placeholding = main.querySelector("[data-placeholder]") !== null
  const scrollTo = placeholding && scrollTarget !== null ? 0 : scrollTarget
  if (!placeholding) scrollTarget = null
  popped = null
  drawnRoute = route
  drawnView = routeView
  const swap = (leave: Leave) => {
    waitingPage = null
    if (keepFocus) focus.keep(document.activeElement)
    swapPage(old, main, scrollTo, leave)
    if (document.querySelector(OVERLAY)) {
      main.inert = true
      behindPopup = [...behindPopup.filter((n) => n !== old), main]
    }
    nameTab()
    if (toHeading !== null) {
      focus.drop()
      if (toHeading) focus.focusHeading()
      return
    }
    if (samePage && focus.restore()) return
    if (!first && (!samePage || arrived || (overlay && !keep))) focus.focusHeading()
  }
  // the new page is laid out at once, for the code drawing it to measure, and shown when it takes the old one's place
  main.classList.add("pending")
  main.inert = true
  old.after(main)
  // A browser skips a view transition asked for before its first paint, so the first page fades in on its own.
  if (first || unseen) {
    swap("at-once")
    return fadeIn(main)
  }
  waitingPage = { main, scrollTo }
  transition(change, () => swap(transitions() ? "at-once" : change), () => finishMotion(old), scrollTo)
}

// Escape closes the popup, and Tab cycles within it
function popupKeys(e: KeyboardEvent): void {
  if (e.key === "Escape") return closePopup()
  const modal = document.querySelector<HTMLElement>(`${OVERLAY} .modal`)
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
let opener: ReturnType<typeof focus.markOf> | null = null

// a popup on its way out stays on screen for its fade, out of the way of the page and of the next popup
const OVERLAY = ".modal-overlay:not(.closing)"
// the popup's own move, as long as its overlay's crossing
const POPUP_MS = CROSS_MS
let behindPopup: HTMLElement[] = []

export function popup(content: HTMLElement): void {
  shut(true, false)
  popupRoute = route
  const active = document.activeElement
  opener = active instanceof HTMLElement && active !== document.body ? focus.markOf(active) : null
  const overlay = el("div", { class: "modal-overlay", onclick: (e: Event) => { if (e.target === overlay) closePopup() } }, content)
  // a popup opened while the last one fades out takes over from where that fade has got to
  const closing = document.querySelector<HTMLElement>(".modal-overlay.closing")
  const from = closing ? Number(getComputedStyle(closing).opacity) : 0
  closing?.remove()
  document.body.append(overlay)
  document.documentElement.classList.add("modal-open")
  content.setAttribute("aria-modal", "true")
  behindPopup = [...document.querySelectorAll<HTMLElement>("body > header.topbar, body > main:not(.pending), body > footer")].filter((n) => !n.inert)
  for (const node of behindPopup) node.inert = true
  if (moving()) {
    overlayIn(overlay, [...content.children], from)
    content.animate({ translate: ["0 10px", "0 0"], scale: [0.98, 1] }, { duration: POPUP_MS, easing: EASE })
  }
  // focus moves into the dialog; a popup with a field focuses that field itself afterwards
  content.querySelector<HTMLElement>("a[href], button:not([disabled]), input")?.focus()
  document.addEventListener("keydown", popupKeys)
}

// refocus false: the caller draws a new page and puts focus on it itself
export function closePopup(refocus = true): void {
  shut(refocus, true)
}

function shut(refocus: boolean, fade: boolean): void {
  document.removeEventListener("keydown", popupKeys)
  const overlay = document.querySelector<HTMLElement>(OVERLAY)
  if (!overlay) return
  // a click on the backdrop has already moved focus to the page itself
  const hadFocus = overlay.contains(document.activeElement) || document.activeElement === document.body
  if (fade && moving()) {
    // inert lets go of focus and clicks at once, as removing it would
    overlay.classList.add("closing")
    overlay.inert = true
    const modal = overlay.querySelector(".modal")
    modal?.animate({ translate: ["0 0", "0 6px"], scale: [1, 0.98] }, { duration: POPUP_MS, easing: EASE, fill: "forwards" })
    overlayOut(overlay, modal ? [...modal.children] : [], () => overlay.remove())
  } else overlay.remove()
  document.documentElement.classList.remove("modal-open")
  for (const node of behindPopup) node.inert = false
  behindPopup = []
  // An opener the page redrew under the popup is found again in the redrawn page; failing that, the heading takes focus,
  // unless the redrawn page has already put focus somewhere of its own.
  const back = opener && (opener.node.isConnected || refocus) ? focus.found(opener) : null
  // the page kept still under the popup, so its opener is where it was
  back?.focus({ preventScroll: true })
  if (refocus && hadFocus && document.activeElement !== back) focus.focusHeading()
  opener = null
}

export function pageHead(title: Node | string | (Node | string)[], lead: Node | string | (Node | string)[] | null = null, crumbs: Node | null = null): HTMLElement {
  return el("section", { class: "page-head" }, el("div", { class: "wrap" },
    crumbs, el("h1", { class: "display" }, title), lead ? el("p", { class: "lead" }, lead) : null))
}

const transient = <T extends HTMLElement>(node: T) => Object.assign(node.dataset, { [TRANSIENT]: "" }) && node
export function crumbs(step: "Details" | "Name code" | "Payment" | "Registration", { fromApp = false, prepaid = false, links = {} as Partial<Record<string, string>> } = {}): HTMLElement {
  const names = ["Search", "Details", fromApp ? null : "Name code", prepaid ? null : "Payment", "Registration"].filter((n): n is string => n !== null)
  const at = names.indexOf(step)
  const shown = document.querySelector<HTMLElement>(`${SHOWN_PAGE} .crumb.on`)
  const from = shown ? Number(shown.dataset.step) : null
  const reached = (i: number) => from !== null && from < i && i <= at
  const named = <T extends HTMLElement>(node: T, name: string, kind: string) => Object.assign(node.style, { viewTransitionName: name, viewTransitionClass: kind }) && node
  const out: Node[] = []
  names.forEach((n, i) => {
    const slug = n.toLowerCase().replace(" ", "-")
    const line = i <= at ? el("i", { class: "crumb-line" }) : null
    if (i) out.push(el("span", { class: "crumb-sep", "data-key": `${slug}-line` }, line && reached(i) ? transient(named(line, `step-line-${slug}`, "line")) : line))
    const tick = live(el("i", {}, i < at ? "✓" : String(i + 1)))
    const mark = i < at && reached(i + 1) ? transient(named(tick, `step-done-${slug}`, "tick")) : tick
    const href = i < at ? links[n] : undefined
    out.push(el("a", { class: "crumb" + (i < at ? " done" : i === at ? " on" : ""), "data-key": slug, "data-step": String(i), href, "aria-current": i === at ? "step" : undefined },
      mark, n, i === at ? el("span", { class: "crumb-ring", "aria-hidden": "true" }) : null))
  })
  return live(el("div", { class: "crumbs" }, ...out))
}

export function crumbsTo(bar: HTMLElement, next: HTMLElement): void {
  const shown = new Map([...bar.children].filter((n) => !n.classList.contains("outgoing")).map((n) => [(n as HTMLElement).dataset.key, n as HTMLElement]))
  syncList(bar, [...next.children].map((step) => {
    const kept = shown.get((step as HTMLElement).dataset.key)
    if (kept) lookOf(kept, step)
    return kept ?? step as HTMLElement
  }))
}

function lookOf(kept: Element, next: Element): void {
  for (const { name } of [...kept.attributes]) if (!next.hasAttribute(name)) kept.removeAttribute(name)
  for (const { name, value } of [...next.attributes]) if (kept.getAttribute(name) !== value) kept.setAttribute(name, value)
  const [now, wanted] = [[...kept.children], [...next.children]]
  if (now.length !== wanted.length || now.some((n, i) => n.tagName !== wanted[i].tagName)) return kept.replaceChildren(...next.childNodes)
  // a step's number turning to a tick crosses, as its mark is a live part
  if (!now.length && kept.textContent !== next.textContent) kept.replaceChildren(next.textContent ?? "")
  now.forEach((n, i) => lookOf(n, wanted[i]))
}

const PLACEHOLDER_AFTER_MS = 500
export function placeholderSoon(): void {
  const mine = route
  const draw = (delayed: boolean) => { if (route === mine && drawnRoute !== mine) page(placeholder(delayed)) }
  const shown = document.querySelector<HTMLElement>(SHOWN_PAGE)
  if (!shown?.childElementCount) return draw(true)
  shown.inert = true
  const timer = setTimeout(() => draw(false), PLACEHOLDER_AFTER_MS)
  whenLeaving(() => clearTimeout(timer))
}

// A page still being read shows where its heading and panels will be, shimmering, rather than a blank page.
export function placeholder(delayed = false): Node[] {
  const kind = delayed ? "delayed" : ""
  const panels = twoCols(el("div", { class: "panel skeleton tall" }), el("div", { class: "panel skeleton" }))
  panels.dataset.placeholder = kind
  return [
    el("section", { class: "page-head", "data-placeholder": kind, "aria-busy": "true" }, el("div", { class: "wrap" },
      el("span", { class: "sr-only" }, "Loading…"), el("div", { class: "skeleton line" }), el("div", { class: "skeleton line short" }))),
    panels,
  ]
}

const BOX_BODY = "box-body"
function withBody(box: Node): Node {
  if (box instanceof HTMLElement && box.hasChildNodes()) box.replaceChildren(el("div", { class: BOX_BODY }, ...box.childNodes))
  return box
}

export function twoCols(main: Node, side: Node): HTMLElement {
  return el("div", { class: "wrap" }, el("div", { class: "cols" }, withBody(main), withBody(side)))
}

// a single outcome, centred, as the badge store's endings are
export function status(tone: string, ic: Parameters<typeof icon>[0], title: string, text: Node | string | (Node | string)[], actions: Node[] = [], extra: { reference?: string; extra?: Node | Node[] } = {}): HTMLElement {
  return el("div", { class: "status-wrap" }, el("div", { class: "panel status" },
    el("div", { class: `orb ${tone}` }, icon(ic)),
    el("h1", { class: "display" }, title),
    el("p", {}, text),
    extra.extra ?? null,
    actions.length ? el("div", { class: "actions" }, ...actions) : null,
    extra.reference ? el("div", { class: "ref" }, el("span", {}, "Reference"), el("span", { class: "mono" }, extra.reference)) : null))
}
