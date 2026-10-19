// Motion: what changes on the page eases in rather than cutting in. Parts of a page that change in place cross what goes
// into what comes and ease to their new height; a page change is a view transition, or a fade through where there is none.
import { AXIS_MS, CROSS_IN, CROSS_MS, CROSS_OUT, CROSS_SWAP, FIREFOX_FIXED, type Pairing, pairingFor, viewTransitionsUsable } from "./motion-values.ts"

export const EASE = "cubic-bezier(.2, .7, .2, 1)"
const ENTER_MS = 220
const RESIZE_MS = 240
const LEAVE_MS = 180
// a little over half a fade out that goes early, by when the node has mostly gone
const SLIDE_DELAY_MS = 100
// the individual translate property, so a node's own transform is left as it is
const RISE = "0 6px"
// the moment in a crossing at which what comes takes over from what goes
const CROSSED_MS = CROSS_MS * CROSS_SWAP

const reduced = matchMedia("(prefers-reduced-motion: reduce)")
export const moving = () => !reduced.matches

export function fadeIn(node: Element): void {
  if (moving()) node.animate({ opacity: [0, 1], translate: [RISE, "0 0"] }, { duration: ENTER_MS, easing: EASE, fill: "backwards" })
}

// What takes another's place crosses in as that one crosses out, rather than rising in.
function crossIn(node: Element): void {
  if (moving()) node.animate({ opacity: [0, 1] }, { duration: CROSS_MS, easing: CROSS_IN, fill: "backwards" })
}
const crossing = new WeakSet<Node>()

// Nodes put into a live part once never fade in again, so a part moved into a redrawn page keeps still.
const shown = new WeakSet<Node>()
function still<T extends Node>(node: T): T {
  shown.add(node)
  return node
}

new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue
      // a live part is watched for its height while it is in the page: observed again when a redraw moves it back in
      if (node.classList.contains("live")) sizes.observe(node)
      for (const part of node.querySelectorAll(".live")) sizes.observe(part)
      if (!(record.target instanceof HTMLElement) || !record.target.classList.contains("live") || shown.has(node)) continue
      shown.add(node)
      if (record.target.closest("main.pending")) continue
      if (crossing.delete(node)) crossIn(node)
      else fadeIn(node)
    }
  }
}).observe(document.body, { childList: true, subtree: true })

// Safari reports a height held from inside the observer's callback as a loop that left notices undelivered; the easing keeps the height, so nothing is lost.
addEventListener("error", (e) => {
  if (!e.message?.startsWith("ResizeObserver loop")) return
  e.preventDefault()
  e.stopImmediatePropagation()
})

// A live part's height follows its content over a moment; while it eases, its own resizes are the easing's.
const heights = new WeakMap<Element, number>()
// a Map, not a WeakMap, so a part can ask whether one inside it is easing; release() takes each out
const easing = new Map<HTMLElement, Animation>()
const sizes = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const node = entry.target as HTMLElement
    // A part taken out of the page keeps the height it had, for a redraw that puts it back; it is no longer watched, so
    // the observer does not hold parts that are gone for good.
    if (!node.isConnected) {
      sizes.unobserve(node)
      continue
    }
    if (easing.has(node)) continue
    const height = entry.borderBoxSize[0].blockSize
    const before = heights.get(node)
    heights.set(node, height)
    if (!moving()) continue
    // a part laid out for the first time inside one that eases, as a part filled while its page fades in, is taken in
    if (before === undefined) carryOuter(node)
    const inner = [...easing.keys()].some((other) => other !== node && node.contains(other))
      || (!node.matches(PAGE) && [...morphing].some((part) => node.contains(part)))
    if (before !== undefined && !inner) easeHeight(node, before, height)
  }
})

const PAGE = "body > main"
const morphing = new Set<HTMLElement>()

// a card's shadow (0 12px 32px) reaches 44 px past it; a focus ring 4 px
const EDGE_ROOM_PX = 48
const EDGE_OPENS_AT = 0.6
const edgeClip = (room: number): Keyframe => ({ clipPath: `inset(${-room}px -100vw)` })
const clips = new Map<HTMLElement, Animation>()

// The old height is held inline at once, so no frame shows the new height before the easing starts.
// The easing holds its end height until the node is let go: without the fill, the frame between its end and the release
// would show the held start height again.
function easeHeight(node: HTMLElement, from: number, to: number, delay = 0): void {
  heights.set(node, to)
  if (Math.abs(to - from) < 1) return
  // read before this one is held at its old height
  carryOuter(node)
  node.style.height = `${from}px`
  const ease = node.animate({ height: [`${from}px`, `${to}px`] }, { duration: RESIZE_MS, delay, easing: EASE, fill: "forwards" })
  easing.set(node, ease)
  clips.get(node)?.cancel()
  clips.set(node, node.animate([edgeClip(0), { ...edgeClip(0), offset: EDGE_OPENS_AT }, edgeClip(EDGE_ROOM_PX)], { duration: RESIZE_MS, delay, fill: "both" }))
  // finish and cancel arrive as events, after a newer easing may have taken over the node
  ease.addEventListener("finish", () => {
    if (easing.get(node) !== ease) return
    release(node)
    ease.cancel()
    // content that grew inside the held height, as a part easing within it, is eased on to rather than jumped to; a
    // part no longer in the page keeps the height it had
    const now = node.getBoundingClientRect().height
    if (moving() && node.isConnected && Math.abs(now - to) >= 1) easeHeight(node, to, now)
  })
  ease.addEventListener("cancel", () => { if (easing.get(node) === ease) release(node) })
}

// A part easing around this one is held at its own height, so it eases on to take this one's new height in.
function carryOuter(node: HTMLElement): void {
  for (const outer of [...easing.keys()]) if (outer !== node && outer.contains(node)) settleHeight(outer, outer.getBoundingClientRect().height)
}

function release(node: HTMLElement): void {
  node.style.removeProperty("height")
  tidyStyle(node)
  clips.get(node)?.cancel()
  clips.delete(node)
  easing.delete(node)
}

// The faded node stays invisible until it is gone: without the fill, the frame between the end and the removal shows it
// whole again. A fade starts from where the node's opacity is, as one interrupted while it fades in is not yet whole.
interface Fade { ms?: number; easing?: string; delay?: number }
export function fadeOut(node: Element, done: () => void, { ms = LEAVE_MS, easing = EASE, delay = 0 }: Fade = {}): void {
  const from = node.isConnected ? Number(getComputedStyle(node).opacity) : 1
  const fade = node.animate({ opacity: [from, 0] }, { duration: ms, easing, delay, fill: "both" })
  fade.addEventListener("finish", () => {
    done()
    fade.cancel()
  })
}

const crossOut = (node: Element, done: () => void) => fadeOut(node, done, { ms: CROSS_MS, easing: CROSS_OUT })

// Two labels taking turns in one place cross.
export function takeTurns(shown: Element, hidden: Element): void {
  if (!moving()) return
  shown.animate({ opacity: [0, 1] }, { duration: CROSS_MS, easing: CROSS_IN })
  hidden.animate({ opacity: [1, 0] }, { duration: CROSS_MS, easing: CROSS_OUT })
}

// An overlay over the page brings its surface before its text and takes its text away before its surface, each over
// half a crossing, so its text never stands over the page's while the surface is see-through.
const SURFACE_MS = CROSSED_MS
const TEXT_MS = CROSS_MS - CROSSED_MS
export function overlayIn(surface: Element, text: Element[], from = 0): void {
  if (!moving()) return
  surface.animate({ opacity: [from, 1] }, { duration: SURFACE_MS, easing: EASE })
  for (const node of text) node.animate({ opacity: [0, 1] }, { duration: TEXT_MS, delay: SURFACE_MS, easing: EASE, fill: "backwards" })
}
export function overlayOut(surface: Element, text: Element[], done: () => void): void {
  for (const node of text) node.animate({ opacity: [1, 0] }, { duration: TEXT_MS, easing: EASE, fill: "forwards" })
  fadeOut(surface, done, { ms: SURFACE_MS, delay: TEXT_MS })
}

// Under a view transition the part's height change waits for its end, as Firefox draws the browser's picture squeezed.
const afterTransition = new WeakMap<HTMLElement, (Node | string)[]>()

function crossFade(part: HTMLElement, given: (Node | string)[]): void {
  if (running && moving() && part.isConnected && !part.closest("main.pending")) {
    if (afterTransition.has(part)) return void afterTransition.set(part, given)
    if (!easing.has(part)) {
      const height = part.getBoundingClientRect().height
      const was = [...part.childNodes]
      const next = given.map(textSpan)
      for (const node of next) if (typeof node !== "string") still(node)
      Element.prototype.replaceChildren.call(part, ...next)
      if (Math.abs(part.getBoundingClientRect().height - height) < 1) return
      Element.prototype.replaceChildren.call(part, ...was)
      for (const node of next) if (typeof node !== "string") shown.delete(node)
    }
    afterTransition.set(part, given)
    void transitionsIdle().then(() => {
      const latest = afterTransition.get(part)
      afterTransition.delete(part)
      if (latest) crossFade(part, latest)
    })
    return
  }
  const outgoing = [...part.children].filter((n) => n.classList.contains("outgoing"))
  // text comes in a span of its own, as only an element can fade in
  const next = given.map(textSpan)
  if (!moving() || !part.isConnected) return Element.prototype.replaceChildren.call(part, ...next, ...outgoing)
  const going = [...part.childNodes].filter((n) => !outgoing.includes(n as Element) && !next.includes(n))
  const seen = going.some((n) => n instanceof Element || n.textContent?.trim())
  const from = paintedHeight(part)
  // what stays is put back by the replacement, which is not what arriving is
  for (const node of next) if (typeof node !== "string" && node.parentNode === part) still(node)
  const slideRow = slideRowOf(part)
  if (!seen) {
    Element.prototype.replaceChildren.call(part, ...next, ...outgoing)
    slideRow()
    if (from !== null) settleHeight(part, from)
    return
  }
  // the old content keeps its own width as it fades, so it does not wrap again inside a narrower part
  const was = part.getBoundingClientRect()
  const layer = still(document.createElement("div"))
  layer.className = "outgoing"
  Object.assign(layer.style, { width: `${was.width}px`, right: "auto" })
  layer.inert = true
  layer.setAttribute("aria-hidden", "true")
  const style = getComputedStyle(part)
  if (style.display.endsWith("flex")) Object.assign(layer.style, { display: "flex", flexDirection: style.flexDirection, flexWrap: style.flexWrap, alignItems: style.alignItems, justifyContent: style.justifyContent, gap: style.gap })
  // focus on what goes moves to what replaces it, as an inert layer would drop it to the page
  const focused = going.some((n) => n.contains(document.activeElement))
  const phases = going.flatMap((n) => n instanceof Element ? loops(n).map((a) => ({ effect: a.effect as KeyframeEffect, name: a.animationName, start: a.startTime })) : [])
  layer.append(...going)
  for (const node of going) shown.delete(node)
  for (const node of next) if (typeof node !== "string" && !shown.has(node)) crossing.add(node)
  Element.prototype.replaceChildren.call(part, ...next, ...outgoing, layer)
  for (const { effect, name, start } of phases) {
    const again = effect.target && start !== null ? loops(effect.target).find((a) => a.animationName === name && (a.effect as KeyframeEffect).target === effect.target && (a.effect as KeyframeEffect).pseudoElement === effect.pseudoElement) : undefined
    if (again) again.startTime = start
  }
  shiftBack(layer, was, part.getBoundingClientRect())
  slideRow()
  if (focused) focusIn(part)
  crossOut(layer, () => removeWhenDrawn(layer))
  // a part that shrinks waits until what goes has given way, so its clip does not cut what is still read
  if (from !== null) settleHeight(part, from, next.length ? CROSSED_MS : 0)
}

// Content taken out of a part shrinks the page until the part's height is held, which would pull the window up the
// page; the page keeps its height until then.
function keepingPageHeight(change: () => void): void {
  const page = document.querySelector<HTMLElement>(PAGE)
  if (!moving() || !page || page.style.minHeight) return change()
  page.style.minHeight = `${page.getBoundingClientRect().height}px`
  try {
    change()
  } finally {
    page.style.removeProperty("min-height")
    tidyStyle(page)
  }
}

export function removeFrom(part: HTMLElement, node: Node, successor: HTMLElement | null = null): void {
  if (node.parentNode !== part) return
  if (!moving() || !(node instanceof HTMLElement) || !part.isConnected) {
    if (successor) part.insertBefore(successor, node)
    part.removeChild(node)
    return
  }
  const wasHeight = paintedHeight(part)
  keepingPageHeight(() => {
    takeOut(part, node, successor)
    if (wasHeight !== null) settleHeight(part, wasHeight, SLIDE_DELAY_MS)
  })
}

// A node taken out with another coming in crosses with it; taken out alone, it fades.
function takeOut(part: HTMLElement, node: HTMLElement, successor: HTMLElement | null, crossed = successor !== null): void {
  const slide = [slideOthers(part, node, { out: true }), slideRowOf(part, true)]
  const at = node.getBoundingClientRect()
  const focused = node.contains(document.activeElement)
  if (successor) {
    crossing.add(successor)
    part.insertBefore(successor, node)
  }
  node.classList.add("outgoing")
  node.inert = true
  node.setAttribute("aria-hidden", "true")
  Object.assign(node.style, { width: `${at.width}px`, right: "auto", margin: "0" })
  shiftBack(node, at, node.getBoundingClientRect())
  if (crossed) crossOut(node, () => removeWhenDrawn(node))
  else fadeOut(node, () => removeWhenDrawn(node))
  slide.forEach((f) => f())
  if (focused) focusIn(part)
}

// Taking out a node the browser is drawing ends its transition at once, so a faded node waits for it.
function removeWhenDrawn(node: Element): void {
  if (!running) return node.remove()
  ;(node as HTMLElement).style.opacity = "0"
  void transitionsIdle().then(() => node.remove())
}

// A node put into a live part fades in, as anything new in one does, while what follows it slides aside for it.
export function addTo(part: HTMLElement, node: HTMLElement, before: Node | null): void {
  const slide = [slideOthers(part, node), slideRowOf(part)]
  part.insertBefore(node, before)
  slide.forEach((f) => f())
}

// The part eases once to its new height, as rows taken out and put in at once are one change, and crosses them.
export function syncList(part: HTMLElement, rows: HTMLElement[]): void {
  keepingPageHeight(() => changeList(part, rows))
}

function changeList(part: HTMLElement, rows: HTMLElement[]): void {
  const wanted = new Set(rows)
  const gone = [...part.children].filter((n) => !n.classList.contains("outgoing") && !wanted.has(n as HTMLElement))
  const coming = rows.some((row) => row.parentNode !== part)
  const eased = moving() && part.isConnected
  const from = eased ? paintedHeight(part) : null
  for (const node of gone) {
    if (eased && node instanceof HTMLElement) takeOut(part, node, null, coming)
    else part.removeChild(node)
  }
  let before: Element | null = part.firstElementChild
  let added = false
  for (const row of rows) {
    while (before?.classList.contains("outgoing")) before = before.nextElementSibling
    if (row.parentNode !== part) {
      if (gone.length) crossing.add(row)
      addTo(part, row, before)
      added = true
    } else if (row !== before) part.insertBefore(row, before)
    before = row.nextElementSibling
  }
  if (from !== null && (gone.length || added)) settleHeight(part, from, gone.length ? SLIDE_DELAY_MS : 0)
}

// The part's other children, read where they are now; the function returned slides each from there to where it is
// after the change, while what fades out inside each stays where it was, and what fades out in the part itself too.
// Making way for a node that fades out, they wait until it has mostly gone, so none slides over it.
function slideOthers(part: HTMLElement, changed: Node, { out = false, across = false } = {}): () => void {
  if (!moving()) return () => undefined
  const children = [...part.children].filter((n): n is HTMLElement => n !== changed && n instanceof HTMLElement)
  const fading = children.filter((n) => n.classList.contains("outgoing"))
  const others = children.filter((n) => !fading.includes(n))
  const [fadingAt, before] = [fading, others].map((nodes) => nodes.map((n) => n.getBoundingClientRect()))
  return () => {
    fading.forEach((n, i) => shiftBack(n, fadingAt[i], n.getBoundingClientRect()))
    others.forEach((n, i) => {
      const now = n.getBoundingClientRect()
      const dx = before[i].left - now.left
      const dy = across ? 0 : before[i].top - now.top
      if (!dx && !dy) return
      const timing = { duration: RESIZE_MS, delay: out ? SLIDE_DELAY_MS : 0, easing: EASE }
      n.animate({ translate: [`${dx}px ${dy}px`, "0 0"] }, { ...timing, fill: "backwards" })
      for (const layer of n.querySelectorAll<HTMLElement>(":scope > .outgoing")) layer.animate({ translate: ["0 0", `${dx}px ${dy}px`] }, { ...timing, fill: "both" })
    })
  }
}

// A part sized to its content in a row moves the row's other boxes when it changes width, and a box around it sized the
// same way moves its own row in turn; each row whose box changed width slides its boxes across, as what moves them down
// is a height, which eases on its own.
function slideRowOf(part: HTMLElement, out = false): () => void {
  if (!moving()) return () => undefined
  const rows: { box: HTMLElement; width: number; slide: () => void }[] = []
  for (let box = part; box.parentElement && !box.matches("main"); box = box.parentElement) {
    rows.push({ box, width: box.getBoundingClientRect().width, slide: slideOthers(box.parentElement, box, { out, across: true }) })
  }
  return () => {
    for (const { box, width, slide } of rows) {
      if (Math.abs(box.getBoundingClientRect().width - width) < 1) break
      slide()
    }
  }
}

// An outgoing layer goes back to where its content was on screen: a part sized to its content in a row moves when what
// it holds changes.
function shiftBack(layer: HTMLElement, was: DOMRect, now: DOMRect): void {
  layer.style.left = `${(parseFloat(layer.style.left) || 0) + was.left - now.left}px`
  layer.style.top = `${(parseFloat(layer.style.top) || 0) + was.top - now.top}px`
}

// focus that was on what goes moves to the part's next control, though never onto one that destroys something
const CONTROLS = ":is(a[href], button:not([disabled]), input):not([data-destructive], .danger)"
function focusIn(part: HTMLElement): void {
  ;[...part.querySelectorAll<HTMLElement>(CONTROLS)].find((n) => !n.closest(".outgoing"))?.focus({ preventScroll: true })
}

const ROLL_MS = 240
const ROLL_BY = "0 .5em"
const ROLL_OUT = "0 -.5em"
function rollCell(cell: HTMLElement, ch: string): void {
  const old = cell.lastElementChild as HTMLElement | null
  const now = still(Object.assign(document.createElement("span"), { textContent: ch }))
  cell.dataset.ch = ch
  cell.append(now)
  if (!old) return
  if (!moving()) return old.remove()
  old.classList.add("outgoing")
  old.setAttribute("aria-hidden", "true")
  const timing = { duration: ROLL_MS, easing: EASE }
  old.animate({ translate: ["0 0", ROLL_OUT] }, { ...timing, fill: "forwards" })
  fadeOut(old, () => old.remove(), { ms: ROLL_MS })
  now.animate({ translate: [ROLL_BY, "0 0"], opacity: [0, 1] }, timing)
}
const FIGURE_SPACE = "\u2007"
export function rollTo(node: HTMLElement, given: string, keepWidth = false): void {
  const row = node.querySelector<HTMLElement>(":scope > .digits")
  const text = row && keepWidth ? given.padStart(row.childElementCount, FIGURE_SPACE) : given
  if (row && row.childElementCount === text.length) {
    ;[...text].forEach((ch, i) => { const cell = row.children[i] as HTMLElement; if (cell.dataset.ch !== ch) rollCell(cell, ch) })
    return
  }
  const fresh = Object.assign(document.createElement("span"), { className: "digits" })
  if (!node.hasChildNodes()) still(fresh)
  for (const ch of text) {
    const cell = Object.assign(document.createElement("span"), { className: "roll" })
    rollCell(cell, ch)
    fresh.append(cell)
  }
  node.replaceChildren(fresh)
}

// text put into a live part, as an element of its own
export const textSpan = (n: Node | string) => typeof n === "string" && n ? Object.assign(document.createElement("span"), { textContent: n }) : n

// what a live part shows now, leaving out what is fading out of it
export function current<T extends Element>(part: ParentNode, selector: string): T | null {
  return [...part.querySelectorAll<T>(selector)].find((n) => !n.closest(".outgoing")) ?? null
}

// The height a part shows now, to ease a change from: mid-easing, where the easing has got to; otherwise the height last
// painted, as layout read now already holds changes made earlier in this task, such as a neighbour narrowing. A part not
// yet laid out, as one filled while its page is drawn, has no height to ease from.
function paintedHeight(part: HTMLElement): number | null {
  if (easing.has(part)) return part.getBoundingClientRect().height
  return heights.get(part) ?? null
}

function settleHeight(part: HTMLElement, from: number, shrinkDelay = 0): void {
  const running = easing.get(part)
  if (running) {
    release(part)
    running.cancel()
  }
  const to = part.getBoundingClientRect().height
  easeHeight(part, from, to, to < from ? shrinkDelay : 0)
}

// a part of the page whose content changes in place
export function live<T extends HTMLElement>(node: T): T {
  node.classList.add("live")
  node.replaceChildren = (...next: (Node | string)[]) => keepingPageHeight(() => crossFade(node, next))
  sizes.observe(node)
  return node
}

const VIEW_TRANSITIONS = viewTransitionsUsable(FIREFOX_FIXED)
export const transitions = () => moving() && VIEW_TRANSITIONS

export type Change = "forward" | "back" | "screen" | "fill"

let running: ViewTransition | null = null
let waiting: (() => void) | null = null

export const TRANSIENT = "transientName"
function unname(): void {
  for (const node of document.querySelectorAll<HTMLElement>("body > main:not(.pending) [data-transient-name]")) {
    node.style.removeProperty("view-transition-name")
    node.style.removeProperty("view-transition-class")
    tidyStyle(node)
    delete node.dataset[TRANSIENT]
  }
}

export function dropWaitingPage(): void {
  queue = []
  if (!waiting) return
  waiting = null
  running?.skipTransition()
}

export function transitionsIdle(): Promise<void> {
  if (!running && !queue.length) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.push(resolve))
}
const idleWaiters: (() => void)[] = []

// prepare runs just before the browser's picture of the old page; scrollTo is where the update scrolls the window.
interface Queued { change: Change; update: () => void; prepare: () => void; scrollTo: number | null }
let queue: Queued[] = []

// A change that scrolls the window pictures the old page and foot apart from the new ones, so neither pair slides by
// the scroll; the transition's type says whether the order's card and name are still paired.
const SCROLL_TYPES: Record<Exclude<Pairing, "all">, string> = { card: "near", none: "far" }
const APART: [string, string][] = [["body > main:not(.pending)", "page-old"], ["body > footer.footer", "page-foot-old"]]

function nameApart(node: HTMLElement, name: string): HTMLElement {
  Object.assign(node.style, { viewTransitionName: name, viewTransitionClass: "page-part" })
  return node
}

function unnameApart(node: HTMLElement): void {
  node.style.removeProperty("view-transition-name")
  node.style.removeProperty("view-transition-class")
  tidyStyle(node)
}

export function transition(change: Change, update: () => void, prepare: () => void = () => undefined, scrollTo: number | null = null): void {
  if (!transitions()) {
    queue.splice(0).forEach((q) => q.update())
    return update()
  }
  const next = { change, update, prepare, scrollTo }
  if (running) {
    queue.push(next)
    return
  }
  begin(next)
}

function begin({ change, update, prepare, scrollTo }: Queued): void {
  prepare()
  unname()
  const pairing = pairingFor(scrollTo, scrollY, innerHeight)
  const apart = pairing === "all" ? [] : APART.flatMap(([selector, name]) => {
    const node = document.querySelector<HTMLElement>(selector)
    return node ? [nameApart(node, name)] : []
  })
  // the old page's names are pictured by now; the foot stays in the page, to be pictured again as the new one
  const run = () => {
    apart.forEach(unnameApart)
    if (waiting !== run) return
    waiting = null
    update()
  }
  waiting = run
  const started = document.startViewTransition({ update: run, types: pairing === "all" ? [change] : [change, SCROLL_TYPES[pairing]] })
  running = started
  // a transition cut short by a newer one rejects ready; the change itself is made either way
  started.ready.catch(() => undefined)
  void started.finished.catch(() => undefined).finally(() => {
    if (running !== started) return
    running = null
    unname()
    if (!transitions()) queue.splice(0).forEach((q) => q.update())
    const next = queue.shift()
    if (!next) return idleWaiters.splice(0).forEach((resolve) => resolve())
    begin(next)
  })
}

export function finishMotion(root: Element): void {
  for (const a of finite(root)) {
    if (unseen(a)) continue
    a.finish()
  }
}

const finite = (root: Element) => root.getAnimations({ subtree: true })
  .filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))

function tidyStyle(node: HTMLElement): void {
  if (!node.getAttribute("style")) node.removeAttribute("style")
}

const unseen = (a: Animation) => a.pending || Number(a.effect?.getComputedTiming().localTime ?? 0) < Number(a.effect?.getTiming().delay ?? 0)

const loops = (root: Element) => root.getAnimations({ subtree: true })
  .filter((a): a is CSSAnimation => a instanceof CSSAnimation && a.effect?.getTiming().iterations === Infinity)

export type Leave = "at-once" | Change
const CARD_NAME = ".summary .order-name"
const CARD_STAYS = "card-stays"
export function swapPage(old: HTMLElement | null, main: HTMLElement, scrollTo: number | null, leave: Leave): void {
  const was = old && !scrollTo && !running ? paintedHeight(old) : null
  if (was !== null) heights.set(main, was)
  const phases = new Map(old ? loops(old).map((a) => [a.animationName, a.startTime]) : [])
  main.classList.remove("pending")
  main.inert = false
  main.classList.toggle(CARD_STAYS, old?.querySelector(CARD_NAME) != null && main.querySelector(CARD_NAME) != null)
  for (const a of loops(main)) {
    const start = phases.get(a.animationName)
    if (start != null) a.startTime = start
  }
  const through = old !== null && leave !== "at-once" && !running && moving() && old.childElementCount > 0
  const axis = leave === "forward" ? AXIS_PX : leave === "back" ? -AXIS_PX : 0
  const pairing = pairingFor(scrollTo, scrollY, innerHeight)
  if (through) leaveThrough(old, axis)
  else old?.remove()
  if (scrollTo !== null) window.scrollTo(0, scrollTo)
  if (through) arrive(main, old, axis, pairing)
  // the page's height eases on any later change, such as a part that fills in once it is read
  sizes.observe(main)
}

// Values match --emphasized and --axis in styles.css.
const AXIS_PX = 16
const EMPHASIZED = "cubic-bezier(.2, 0, 0, 1)"
function leaveThrough(old: HTMLElement, axis: number): void {
  for (const earlier of document.querySelectorAll(".page-leaving")) earlier.remove()
  const box = old.getBoundingClientRect()
  const leaving = Object.assign(document.createElement("div"), { className: "page-leaving", inert: true })
  leaving.setAttribute("aria-hidden", "true")
  Object.assign(leaving.style, { top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px` })
  old.replaceWith(leaving)
  leaving.append(old)
  for (const node of old.querySelectorAll("[id]")) node.removeAttribute("id")
  if (axis) leaving.animate({ translate: ["0 0", `${-axis}px 0`] }, { duration: AXIS_MS, easing: EMPHASIZED, fill: "forwards" })
  const fade = leaving.animate({ opacity: [1, 0] }, { duration: CROSS_MS, easing: CROSS_OUT, fill: "forwards" })
  fade.addEventListener("finish", () => leaving.remove())
  fade.addEventListener("cancel", () => leaving.remove())
}

type Kept = "whole" | "box" | "text"
// card: paired when the window scrolls a little, as the order's card and name are; scales: text drawn at another size
interface Shared { selector: string; kept: Kept; resizes: boolean; card: boolean; scales: boolean }
const SHARED: Shared[] = [
  { selector: ".order-name", kept: "whole", resizes: false, card: true, scales: true },
  { selector: ".summary", kept: "whole", resizes: true, card: true, scales: false },
  { selector: ".summary > .box-body", kept: "whole", resizes: false, card: true, scales: false },
  { selector: ".crumbs", kept: "whole", resizes: false, card: false, scales: false },
  { selector: ".crumb-ring", kept: "whole", resizes: false, card: false, scales: false },
  { selector: ".cols > .panel:first-child", kept: "box", resizes: true, card: false, scales: false },
  { selector: ".page-head h1", kept: "text", resizes: false, card: false, scales: false },
  { selector: ".page-head .lead", kept: "text", resizes: false, card: false, scales: false },
]
const SHARED_BY: Record<Pairing, Shared[]> = { all: SHARED, card: SHARED.filter((p) => p.card), none: [] }
const STILL_PX = 0.5
const NO_BOX: Keyframe = { backgroundColor: "transparent", borderColor: "transparent", boxShadow: "none" }
const CROSSING_IN: KeyframeAnimationOptions = { duration: CROSS_MS, easing: CROSS_IN, fill: "backwards" }
// a card that arrives with the name fills in once the name has landed, as it would otherwise cross the card's words
const LANDED_MS = AXIS_MS - CROSS_MS
const PSEUDOS = ["::before", "::after"]
const transparent = (color: string) => color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color)

function isSurface(node: Element): boolean {
  if (!(node instanceof HTMLElement) || node.childElementCount === 0) return false
  if ([...node.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim())) return false
  const style = getComputedStyle(node)
  if (style.backgroundImage !== "none" || PSEUDOS.some((p) => !["none", "normal"].includes(getComputedStyle(node, p).content))) return false
  return !transparent(style.backgroundColor) || style.boxShadow !== "none" || parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) > 0
}

function arrive(main: HTMLElement, old: HTMLElement, axis: number, pairing: Pairing): void {
  const pairs = SHARED_BY[pairing].flatMap(({ selector, kept, resizes, scales }) => {
    const from = old.querySelector<HTMLElement>(selector)
    const to = main.querySelector<HTMLElement>(selector)
    const scale = scales && from && to ? parseFloat(getComputedStyle(from).fontSize) / parseFloat(getComputedStyle(to).fontSize) : 1
    return from && to ? [{ to, kept, resizes, scale, was: from.getBoundingClientRect(), now: to.getBoundingClientRect(), from }] : []
  })
  const whole = new Map<Element, Element>(pairs.filter((p) => p.kept === "whole").map((p) => [p.to, p.from]))
  const keptOld = new Set(whole.values())
  const going = pairs.filter((p) => p.kept !== "text").flatMap((p) => {
    const staying = new Set(p.kept === "box" ? [] : alikeOf(p.to, p.from, keptOld).values())
    return [...p.from.children].filter((child) => !keptOld.has(child) && !staying.has(child))
      .map((child) => ({ part: p.to, was: p.was, node: child as HTMLElement, at: child.getBoundingClientRect() }))
  })
  const offset = (p: typeof pairs[number]) => [p.was.left - p.now.left, p.was.top - p.now.top]
  // Read before the parts are held at their old size; parts resizing in opposite ways would otherwise swing the row.
  const resizing = pairs.filter((p) => p.resizes && Math.abs(p.was.height - p.now.height) >= STILL_PX)
  const rows = new Map(resizing.filter((p) => resizing.some((o) => o !== p && o.to.parentElement === p.to.parentElement))
    .map((p) => [p.to.parentElement!, [p.from.parentElement!.getBoundingClientRect().height, p.to.parentElement!.getBoundingClientRect().height]]))
  for (const p of pairs) {
    if (p.kept !== "text") hideWhereSeen(p.from)
    const outer = pairs.filter((o) => o !== p && o.to.contains(p.to)).reduce<typeof p | null>((inner, o) => !inner || inner.to.contains(o.to) ? o : inner, null)
    const [x, y] = offset(p)
    const [ox, oy] = outer ? offset(outer) : [0, 0]
    const timing = { duration: AXIS_MS, easing: EMPHASIZED }
    // the name grows or shrinks from its own top left corner along its way, from the size it had
    if (p.scale !== 1) p.to.animate({ scale: [p.scale, 1], transformOrigin: ["0 0", "0 0"] }, timing)
    if (Math.abs(x - ox) >= STILL_PX || Math.abs(y - oy) >= STILL_PX) p.to.animate({ translate: [`${x - ox}px ${y - oy}px`, "0 0"] }, timing)
    if (p.resizes && Math.abs(p.was.height - p.now.height) >= STILL_PX) {
      const morph = p.to.animate(p.was.height < p.now.height
        ? [{ height: `${p.was.height}px`, ...edgeClip(0) }, { ...edgeClip(0), offset: EDGE_OPENS_AT }, { height: `${p.now.height}px`, ...edgeClip(EDGE_ROOM_PX) }]
        : [{ height: `${p.was.height}px` }, { height: `${p.now.height}px` }], timing)
      morphing.add(p.to)
      for (const ended of ["finish", "cancel"]) morph.addEventListener(ended, () => morphing.delete(p.to))
    }
  }
  for (const [row, [was, now]] of rows) row.animate({ height: [`${was}px`, `${now}px`] }, { duration: AXIS_MS, easing: EMPHASIZED })
  // Read before what goes leaves the old parts.
  const landing = pairs.some((p) => p.from.matches(".order-name")) && !pairs.some((p) => p.from.matches(".summary"))
  const through = { whole, boxes: pairs.filter((p) => p.kept === "box").map((p) => p.to), texts: pairs.filter((p) => p.kept === "text").map((p) => p.to),
    surfaces: [...main.querySelectorAll("*")].filter(isSurface), landing: landing ? main.querySelector(".summary > .box-body") : null }
  fadeThrough(main, null, through, axis)
  for (const { part, was, node, at } of going) fadeOutOver(part, was, node, at)
  for (const line of main.querySelectorAll<HTMLElement>(".crumb-line[data-transient-name]")) {
    line.animate({ scale: ["0 1", "1 1"], transformOrigin: ["left", "left"] }, { duration: AXIS_MS, easing: EMPHASIZED })
  }
  for (const tick of main.querySelectorAll<HTMLElement>(".crumb > i[data-transient-name]")) {
    tick.animate({ scale: [0.4, 1], opacity: [0, 1] }, { duration: AXIS_MS, delay: CROSSED_MS, easing: EMPHASIZED, fill: "backwards" })
  }
}

function hideWhereSeen(node: HTMLElement): void {
  for (const a of node.getAnimations({ subtree: true })) {
    // commitStyles cannot write a pseudo-element's style
    if ((a.effect as KeyframeEffect | null)?.pseudoElement) continue
    a.commitStyles()
    a.cancel()
  }
  node.style.visibility = "hidden"
}

function fadeOutOver(part: HTMLElement, was: DOMRect, old: HTMLElement, at: DOMRect): void {
  const placed = getComputedStyle(part).position === "static"
  if (placed) part.style.position = "relative"
  const node = old.cloneNode(true) as HTMLElement
  node.classList.add("outgoing")
  node.inert = true
  node.setAttribute("aria-hidden", "true")
  Object.assign(node.style, { left: `${at.left - was.left - part.clientLeft}px`, top: `${at.top - was.top - part.clientTop}px`, width: `${at.width}px`, right: "auto", margin: "0" })
  part.append(still(node))
  crossOut(node, () => {
    node.remove()
    if (!placed || part.querySelector(":scope > .outgoing")) return
    part.style.removeProperty("position")
    tidyStyle(part)
  })
}

type Match = (a: Element, b: Element) => boolean
const alike: Match = (a, b) => a.tagName === b.tagName && a.className === b.className && a.textContent === b.textContent
const samePlace: Match = (a, b) => alike(a, b) || (a.tagName === b.tagName && a instanceof HTMLElement && b instanceof HTMLElement
  && a.dataset.step !== undefined && a.dataset.step === b.dataset.step)

function alikeOf(part: Element, old: Element, kept: Set<Element>, match: Match = alike): Map<Element, Element> {
  const free = [...old.children].filter((c) => !kept.has(c))
  const pairs = new Map<Element, Element>()
  for (const child of part.children) {
    const at = free.findIndex((o) => match(child, o))
    if (at >= 0) pairs.set(child, free.splice(at, 1)[0])
  }
  return pairs
}

interface Through { whole: Map<Element, Element>; boxes: Element[]; texts: Element[]; surfaces: Element[]; landing: Element | null }
function fadeThrough(root: Element, was: Element | null, through: Through, axis: number): void {
  const { whole, boxes, texts, surfaces, landing } = through
  const keptOld = new Set(whole.values())
  const alikes = was ? alikeOf(root, was, keptOld, samePlace) : new Map<Element, Element>()
  const used = new Set(alikes.values())
  const [wasBox, box] = [was?.getBoundingClientRect(), root.getBoundingClientRect()]
  for (const child of root.children) {
    const kept = whole.get(child)
    if (kept) {
      fadeThrough(child, kept, through, 0)
      continue
    }
    const twin = alikes.get(child)
    if (twin && wasBox) {
      moveWithin(child, twin.getBoundingClientRect(), wasBox, box)
      if (!alike(child, twin)) child.animate({ opacity: [0, 1] }, CROSSING_IN)
      continue
    }
    if (boxes.includes(child)) {
      fadeThrough(child, null, through, 0)
      continue
    }
    if (![...whole.keys(), ...surfaces].some((n) => child.contains(n))) {
      child.animate({ opacity: [0, 1] }, { ...CROSSING_IN, delay: landing?.contains(child) ? LANDED_MS : 0 })
      if (axis && !texts.includes(child)) child.animate({ translate: [`${axis}px 0`, "0 0"] }, { duration: AXIS_MS, easing: EMPHASIZED })
      continue
    }
    child.animate([NO_BOX, {}], { duration: CROSS_MS, easing: CROSS_IN })
    const counterpart = was ? [...was.children].find((o) => !used.has(o) && !keptOld.has(o) && o.tagName === child.tagName && o.className === child.className) ?? null : null
    if (counterpart) used.add(counterpart)
    fadeThrough(child, counterpart, through, axis)
  }
}

function moveWithin(child: Element, at: DOMRect, wasBox: DOMRect, box: DOMRect): void {
  const now = child.getBoundingClientRect()
  const x = at.left - wasBox.left - (now.left - box.left)
  const y = at.top - wasBox.top - (now.top - box.top)
  if (Math.abs(x) >= STILL_PX || Math.abs(y) >= STILL_PX) child.animate({ translate: [`${x}px ${y}px`, "0 0"] }, { duration: AXIS_MS, easing: EMPHASIZED })
}
