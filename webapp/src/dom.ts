// Building blocks for the views, as the mockups (plans/names-codes/mockups/domains.js) draw them.
import { seconds } from "./format.ts"
import { icon, type IconName } from "./icons.ts"

export type Kid = Node | string | null | undefined | false | Kid[]
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

export function refill<T extends Element>(node: T, ...kids: Kid[]): T {
  node.replaceChildren()
  append(node, kids)
  return node
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches

function append(node: Node, kids: Kid[]): void {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue
    if (Array.isArray(kid)) append(node, kid)
    else node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid)
  }
}

const COUNT_MARK = "\u0000"

// A wait the service asked for, counted down in node until signal ends it; done runs when it is over.
// A screen reader hears the wait once rather than every second: the countdown is hidden from it, a still copy is not.
export function waitOut(node: HTMLElement, waitSeconds: number, text: (left: string) => string, done: () => void, signal: AbortSignal): void {
  node.setAttribute("aria-hidden", "true")
  node.before(el("span", { class: "sr-only" }, text(seconds(waitSeconds))))
  const [before, after] = text(COUNT_MARK).split(COUNT_MARK)
  const count = el("span", {})
  const unit = document.createTextNode("")
  node.replaceChildren(before, count, unit, after)
  const until = Date.now() + waitSeconds * 1000
  // a count started before its notice goes into the page writes its first line at once, so the notice comes in whole
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000)
    if (left > 0) {
      count.textContent = String(left)
      unit.textContent = seconds(left).slice(String(left).length)
      return
    }
    clearInterval(timer)
    // a wait already over ends after the caller has put its notice in, so the end clears it
    queueMicrotask(done)
  }
  if (signal.aborted) return
  const timer = setInterval(tick, 1000)
  signal.addEventListener("abort", () => clearInterval(timer), { once: true })
  tick()
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

export type Tone = "ok" | "warn" | "danger" | "info"

export function alertBox(tone: Tone, ic: IconName, title: string | null, text: Kid): HTMLDivElement {
  return el("div", { class: `notice ${tone}` }, icon(ic), el("div", {}, title ? el("b", {}, title) : null, text))
}

// a name this long is drawn smaller and runs on in its line, so it fits a phone; a shorter one moves to the next line whole
const LONG_NAME = 24
const isLong = (label: string) => label.length > LONG_NAME
const nameClass = (label: string) => isLong(label) ? "long" : "inline-name"

export function nameText(label: string, tld: string): HTMLSpanElement {
  return el("span", { class: nameClass(label) }, label, el("wbr"), `.${tld}`)
}

// a long name breaks before its top-level domain first
export function nameTitle(label: string, cls = "name", tld = "simplex"): HTMLDivElement {
  return el("div", { class: isLong(label) ? `${cls} long` : cls }, label, el("wbr"), el("span", {}, `.${tld}`))
}

export function gradName(label: string, tld = "simplex"): HTMLSpanElement {
  return el("span", { class: `grad ${nameClass(label)}` }, label, el("wbr"), `.${tld}`)
}

export function liveRegion(cls?: string): HTMLDivElement {
  return el("div", { class: cls, role: "status", "aria-live": "polite" })
}

export function disabled<T extends HTMLElement>(node: T): T {
  node.setAttribute("disabled", "")
  return node
}

export function setAction(button: HTMLButtonElement, busy: boolean, held: boolean): HTMLButtonElement {
  button.disabled = busy || held
  if (busy) button.setAttribute("aria-busy", "true")
  else button.removeAttribute("aria-busy")
  return button
}

const COPIED_MS = 1500
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
  return el("div", { class: "code-display" }, el("span", { class: "code-text", "data-testid": testId }, ...parts), copyButton(code, "field-copy", "Copy code"))
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

const COPY = "Copy"
export function copyButton(value: string, cls: string, name = COPY): HTMLButtonElement {
  const note = el("span", { class: "copied-note", "aria-hidden": "true" })
  const button = el("button", { class: `copy-btn ${cls}`.trim(), type: "button", "aria-label": name }, COPY, note)
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
