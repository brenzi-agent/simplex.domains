// Building blocks for the views, as the mockups (plans/names-codes/mockups/domains.js) draw them.
import { keep } from "./focus.ts"
import { live, moving, rollTo } from "./motion.ts"
import { CROSS_MS } from "./motion-values.ts"
import { seconds } from "./format.ts"
import { icon, type IconName } from "./icons.ts"

type Kid = Node | string | null | undefined | false | Kid[]
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (typeof v === "function") node.addEventListener(k.replace(/^on/, ""), v)
    else node.setAttribute(k, v === true ? "" : v)
  }
  append(node, kids)
  return node
}

function append(node: Node, kids: Kid[]): void {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue
    if (Array.isArray(kid)) append(node, kid)
    else node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid)
  }
}

const COUNT_MARK = "\u0000"

// A wait the service asked for, counted down in node; done runs when it is over. It stops once node leaves the page.
// A screen reader hears the wait once rather than every second: the countdown is hidden from it, a still copy is not.
export function waitOut(node: HTMLElement, waitSeconds: number, text: (left: string) => string, done: () => void): void {
  node.setAttribute("aria-hidden", "true")
  node.before(el("span", { class: "sr-only" }, text(seconds(waitSeconds))))
  const [before, after] = text(COUNT_MARK).split(COUNT_MARK)
  const count = live(el("span", { class: "count" }))
  const unit = document.createTextNode("")
  node.replaceChildren(before, count, unit, after)
  const until = Date.now() + waitSeconds * 1000
  // a count started before its notice goes into the page writes its first line at once, so the notice comes in whole;
  // one taken out of the page stops
  let shown = false
  const tick = () => {
    if (node.isConnected) shown = true
    else if (shown) return clearInterval(timer)
    const left = Math.ceil((until - Date.now()) / 1000)
    if (left > 0) {
      rollTo(count, String(left))
      unit.textContent = seconds(left).slice(String(left).length)
      return
    }
    clearInterval(timer)
    // a wait already over ends after the caller has put its notice in, so the end clears it
    queueMicrotask(done)
  }
  const timer = setInterval(tick, 1000)
  tick()
}

// the spinner and the label cross back, as .btn.settling in styles.css
const SETTLE_MS = CROSS_MS
const settling = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

export function working(button: HTMLButtonElement): HTMLButtonElement {
  disabled(button)
  clearTimeout(settling.get(button))
  button.classList.remove("settling")
  button.style.minWidth = `${button.getBoundingClientRect().width}px`
  button.classList.add("working")
  button.setAttribute("aria-busy", "true")
  return button
}

function idle(button: HTMLElement): void {
  if (!button.classList.contains("working")) return
  button.classList.remove("working")
  button.removeAttribute("aria-busy")
  const done = () => {
    button.classList.remove("settling")
    button.style.removeProperty("min-width")
  }
  if (!moving()) return done()
  button.classList.add("settling")
  settling.set(button, setTimeout(done, SETTLE_MS))
}

export function release(button: HTMLButtonElement): void {
  idle(button)
  button.removeAttribute("disabled")
  if (button.isConnected && document.activeElement === document.body) button.focus({ preventScroll: true })
}

export function btn(text: Kid, cls = "", onclick?: () => void, ...extra: Kid[]): HTMLButtonElement {
  return el("button", { class: `btn ${cls}`.trim(), type: "button", onclick }, text, ...extra)
}

export function link(text: Kid, onclick: () => void): HTMLAnchorElement {
  return el("a", { href: "#", role: "button", onclick: (e: Event) => { e.preventDefault(); onclick() } }, text)
}

export function chip(text: string, cls = "", dot = false): HTMLSpanElement {
  return el("span", { class: `chip ${cls}`.trim() }, dot ? el("span", { class: "dot" }) : null, text)
}

type Tone = "ok" | "warn" | "danger" | "info"

export function alertBox(tone: Tone, ic: IconName, title: string | null, text: Kid): HTMLDivElement {
  return el("div", { class: `notice ${tone}` }, icon(ic), el("div", {}, title ? el("b", {}, title) : null, text))
}

// punctuation after the name is kept on its line
export function nameText(label: string, tld: string, after = ""): HTMLSpanElement {
  return el("span", { class: "inline-name" }, label, el("wbr"), `.${tld}${after}`)
}

// a long name breaks before its top-level domain first
export function nameTitle(label: string, cls = "name", tld = "simplex"): HTMLDivElement {
  return el("div", { class: cls }, label, el("wbr"), el("span", {}, `.${tld}`))
}

// a long name breaks before its top-level domain rather than inside a word
export function gradName(label: string, tld = "simplex"): HTMLSpanElement {
  return el("span", { class: "grad" }, label, el("wbr"), `.${tld}`)
}

// where a page writes the answer to an action, announced by screen readers when it changes
export function liveRegion(cls?: string): HTMLDivElement {
  return live(el("div", { class: cls, role: "status", "aria-live": "polite" }))
}

export function disabled<T extends HTMLElement>(node: T, off = true): T {
  // a button turned off drops focus to the page; a redraw of the page gives it back to the button or its successor
  if (off && node === document.activeElement) keep(node)
  if (off) node.setAttribute("disabled", "")
  if (off) idle(node)
  return node
}

const COPIED_MS = 2000
const COPIED_FADE_MS = 200
const copiedTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>[]>()
export function codeDisplay(code: string, testId?: string): HTMLElement {
  // Firefox ends no line at a hyphen before a digit, so each hyphen past the first is followed by a break opportunity;
  // a line never starts with a hyphen.
  const groups = code.split("-")
  const parts = groups.flatMap((group, i) => {
    const text = i < groups.length - 1 ? `${group}-` : group
    return i > 1 ? [el("wbr"), text] : [text]
  })
  return el("div", { class: "code-display", "data-testid": testId }, el("span", { class: "code-text" }, ...parts), copyButton(code, null, "field-copy corner-copy", "Copy code"))
}

let announcer: HTMLElement | null = null
function announce(text: string): void {
  announcer ??= document.body.appendChild(el("div", { class: "sr-only", role: "status" }))
  announcer.textContent = ""
  // the text is set after the region is emptied, so the same words said again are read again
  requestAnimationFrame(() => { if (announcer) announcer.textContent = text })
}

let lastCopied: { button: HTMLElement; note: HTMLElement } | null = null
function uncopy(button: HTMLElement, note: HTMLElement): void {
  copiedTimers.get(button)?.forEach(clearTimeout)
  button.classList.remove("copied")
  copiedTimers.set(button, [setTimeout(() => { note.textContent = "" }, COPIED_FADE_MS)])
}

export function copyButton(value: string, label: string | null, cls: string, name = label ?? "Copy"): HTMLButtonElement {
  const note = el("span", { class: "copied-note", "aria-hidden": "true" })
  const button = el("button", { class: `copy-btn ${cls}`.trim(), type: "button", "aria-label": name },
    el("span", { class: "copy-icons", "aria-hidden": "true" }, icon("copy"), icon("check")), label, note)
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      return
    }
    if (lastCopied && lastCopied.button !== button) uncopy(lastCopied.button, lastCopied.note)
    lastCopied = { button, note }
    copiedTimers.get(button)?.forEach(clearTimeout)
    note.textContent = "Copied!"
    button.classList.add("copied")
    announce("Copied")
    copiedTimers.set(button, [setTimeout(() => uncopy(button, note), COPIED_MS)])
  })
  return button
}

export { icon }
