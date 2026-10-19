import * as api from "../api.ts"
import { alertBox, disabled, el, release, waitOut, working } from "../dom.ts"
import { textSpan } from "../motion.ts"
import type { Hold } from "../screens/machine.ts"
import type { Built } from "./shell.ts"

export function changeTo(part: HTMLElement, ...content: (Node | string)[]): void {
  const shown = [...part.childNodes].filter((n) => !(n instanceof Element && n.classList.contains("outgoing")))
  if (markup(shown) !== markup(content)) part.replaceChildren(...content)
}
const markup = (nodes: (Node | string)[]) => nodes.map((n) => {
  const node = textSpan(typeof n === "string" ? n : n instanceof Text ? n.data : n)
  return node instanceof Element ? node.outerHTML : ""
}).join("")

const drawnAs = new WeakMap<HTMLElement, string>()
export function drawAs(part: HTMLElement, key: string, draw: () => (Node | string)[]): void {
  if (drawnAs.get(part) === key) return
  drawnAs.set(part, key)
  part.replaceChildren(...draw())
}

export const secondsLeft = (hold: Hold) => Math.ceil((hold.until - api.serviceNow()) / 1000)

export function holdNotice(hold: Hold): HTMLElement {
  const line = el("span", {})
  const notice = el("div", { class: "left mt-14" }, alertBox("warn", "clock", "Too many attempts", line))
  waitOut(line, secondsLeft(hold), (left) => `${hold.lead}Try again in ${left}.`, () => undefined)
  return notice
}

export function setAction(button: HTMLButtonElement, busy: boolean, held: boolean): void {
  if (busy) {
    if (!button.classList.contains("working")) working(button)
  } else if (held) {
    if (!button.disabled || button.classList.contains("working")) disabled(button)
  } else if (button.disabled) {
    release(button)
  }
}

export const unchanging = <S>(sections: Node[]): Built<S> => ({ sections, update: () => undefined })
