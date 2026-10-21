// The chats a name opens, drawn as the app draws them: its default pictures, and its connection alert as a popup.
import type * as api from "../api.ts"
import { copyButton, el } from "../dom.ts"
import { chatIcon } from "../icons.ts"
import { qrSvg } from "../qr.ts"
import { focusOn, onPageLeft } from "./shell.ts"

const KIND_NAMES: Record<api.ChatKind, string> = { contact: "Contact address", channel: "Channel", business: "Business address", bot: "Bot" }
// links from the service come from records on chain, which anyone can write: only SimpleX and https links are followed
const SAFE_LINK = /^(simplex:\/|https:\/\/)/
const POPUP_TITLE_ID = "chat-title"
// the popup's return value when the page it was opened on is left, which takes focus elsewhere
const LEFT = "left"
let shownDialog: HTMLDialogElement | null = null
onPageLeft(() => shownDialog?.close(LEFT))

export const chatPicture = (p: api.Profile) => el("span", { class: "chat-pic" }, p.image ? el("img", { src: p.image, alt: "" }) : chatIcon(p.kind))

// a link's profile on one line, with what kind of chat it is where nothing else says so
export const profileLine = (p: api.Profile, withKind = false) => el("span", { class: "entity" }, chatPicture(p),
  el("b", { title: p.displayName }, p.displayName), withKind ? el("small", {}, KIND_NAMES[p.kind]) : null)

// `name` is the name with its TLD, which the popup shows as the app's alert does; `key` brings focus back to the button
export function chatButton(e: api.Entity, name: string, key: string): HTMLButtonElement {
  return el("button", { class: "chat", type: "button", title: `${e.displayName} · ${KIND_NAMES[e.kind]}`, "aria-label": `${e.displayName}, ${KIND_NAMES[e.kind].toLowerCase()}`,
    "aria-haspopup": "dialog", "data-focus": key, onclick: () => openChat(e, name, key) }, chatPicture(e))
}

const subscribers = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "subscriber" : "subscribers"}`

// After the app's connection plan alert (ConnectPlan.kt, AlertManager.showOpenChatAlert): the profile, its link as a QR, open and copy.
function openChat(e: api.Entity, name: string, key: string): void {
  const dialog = el("dialog", { class: "modal", "aria-labelledby": POPUP_TITLE_ID })
  const close = () => dialog.close()
  const open = SAFE_LINK.test(e.deepLink) ? el("a", { class: "btn", href: e.deepLink }, e.kind === "channel" ? "Open channel in SimpleX" : "Open in SimpleX") : null
  const qr = SAFE_LINK.test(e.link) ? qrSvg(e.link, `QR code of the link to ${e.displayName}`) : null
  dialog.append(el("div", { class: "modal-backdrop", onclick: close }),
    el("div", { class: "pop" },
      chatPicture(e),
      el("h2", { id: POPUP_TITLE_ID }, e.displayName),
      el("span", { class: "soft" }, `${e.kind === "channel" ? "#" : "@"}${name}`),
      e.fullName ? el("span", {}, e.fullName) : null,
      e.subscribers === null ? null : el("span", { class: "soft" }, subscribers(e.subscribers)),
      qr && el("div", { class: "pop-qr" }, qr),
      el("div", { class: "pop-acts" }, open, copyButton(e.link, "btn quiet", "Copy link", "Copy link")),
      el("button", { class: "text-link", type: "button", onclick: close }, "Close")))
  dialog.addEventListener("close", () => {
    shownDialog = null
    dialog.remove()
    if (dialog.returnValue !== LEFT) focusOn(key)
  })
  shownDialog = dialog
  document.body.append(dialog)
  dialog.showModal()
  open?.focus()
}
