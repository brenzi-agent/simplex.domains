import * as api from "../api.ts"
import { el, icon, line, nameText, nameTitle } from "../dom.ts"
import { blocksOf, spansOf } from "../markdown.ts"
import { POPUP_TITLE, showPopup } from "./shell.ts"

const TERMS_CHANGED = "The terms changed. Agree to them again."
const INFO_KEY = "community-info"
const TERMS_KEY = "community-terms"
// the terms hash of a name policy that has no community terms yet, under which a community name cannot be ordered
export const NO_TERMS = `0x${"0".repeat(64)}`
export const CANT_SHOW = "The community terms can't be shown now. Try again in a moment."
export const NOT_SET = "This community name can't be ordered yet: its community terms are not set."

function showCommunity(label: string, tld: string, community: api.Community | null, key: string): void {
  showPopup(key, [
    el("h2", { id: POPUP_TITLE }, nameText(label, tld)),
    el("span", { class: "soft" }, "Community name"),
    el("p", {}, community?.for ? `This name is for ${community.for}. ` : "", "Its owner agrees to use it for this community, not as the name of one person or business."),
  ], null)
}

// the terms' own headings come under the page's heading, and a popup's
const HEADINGS = ["h3", "h4", "h5", "h6"] as const
const inline = (text: string) => spansOf(text).map((s) => s.strong ? el("strong", {}, s.text) : s.em ? el("em", {}, s.text) : s.text)

// The community terms' Markdown drawn as headings, paragraphs and lists, which scroll in their box.
export function termsText(text: string): HTMLDivElement {
  return el("div", { class: "terms-text", tabindex: "0" }, blocksOf(text).map((b) =>
    b.kind === "heading" ? el(HEADINGS[Math.min(b.level, HEADINGS.length) - 1], {}, inline(b.text))
    : b.kind === "paragraph" ? el("p", {}, inline(b.text))
    : el(b.ordered ? "ol" : "ul", {}, b.items.map((item) => el("li", {}, inline(item))))))
}

// the community terms' text as the service reads it from the chain
function showTerms(community: api.Community, key: string): void {
  const reading = el("p", { class: "note" }, "Loading the terms…")
  showPopup(key, [el("h2", { id: POPUP_TITLE }, "Community terms"), reading], null)
  api.communityTerms(community.terms).then((read) => reading.replaceWith(termsText(read)), () => { reading.textContent = CANT_SHOW })
}

// `listed` marks a community name whose entry is not read yet, so the marker takes its place before the entry comes
export function rowName(label: string, tld: string, community: api.Community | null, key: string, listed = community !== null): HTMLDivElement {
  if (!listed) return nameTitle(label, "name", tld)
  const marker = el("button", { class: "cmark", type: "button", "aria-label": "Community name: about it", "aria-haspopup": "dialog", "data-focus": key,
    onclick: () => showCommunity(label, tld, community, key) }, "Community", icon("info"))
  return nameTitle(label, "name comm", tld, " ", marker)
}

export interface Agreement {
  terms: api.Terms
  community: api.Community | null
  agreed: boolean
  accepted?: boolean
  changed: boolean
  label: string
  tld: string
  disabled: boolean
}

export function termsCheck(a: Agreement, agree: (agreed: boolean) => void): HTMLLabelElement {
  const unset = a.community?.terms.hash === NO_TERMS
  const box = el("input", { type: "checkbox", checked: a.agreed, disabled: a.disabled || unset, "data-focus": "agreed" })
  box.addEventListener("change", () => agree(box.checked))
  const terms = el("a", { class: "nowrap", href: a.terms.url, target: "_blank", rel: "noopener" }, "SimpleX name terms")
  const words = unset ? [NOT_SET]
    : ["I agree to ", terms, " and do not knowingly violate any trademarks."]
  return el("label", { class: "check terms" }, box, el("span", { class: "box" }), el("span", {}, ...words))
}

// A community name's own tick: its words open the community terms' text, unless their step shows it above them, and its ⓘ
// says what the name is for.
export function communityCheck(a: Agreement, accept: (accepted: boolean) => void, shown = false): HTMLLabelElement {
  const community = a.community!
  const box = el("input", { type: "checkbox", checked: a.accepted, disabled: a.disabled, "data-focus": "accepted" })
  box.addEventListener("change", () => accept(box.checked))
  const terms = shown ? "community terms" : el("button", { class: "text-link", type: "button", "aria-haspopup": "dialog", "data-focus": TERMS_KEY,
    onclick: () => showTerms(community, TERMS_KEY) }, "community terms")
  return el("label", { class: "check terms" }, box, el("span", { class: "box" }), el("span", {}, "I accept the ", terms, " and will use this name for its community.",
    el("button", { class: "cinfo", type: "button", "aria-label": "Which community this name is for", "aria-haspopup": "dialog", "data-focus": INFO_KEY,
      onclick: () => showCommunity(a.label, a.tld, community, INFO_KEY) }, icon("info"))))
}

// the name terms' box, under a community name's own tick where an order signs both
export function termsChecks(a: Agreement, agree: (agreed: boolean) => void, accept?: (accepted: boolean) => void): HTMLElement {
  const name = termsCheck(a, agree)
  return a.community && accept && a.community.terms.hash !== NO_TERMS ? el("div", { class: "checks" }, communityCheck(a, accept), name) : name
}

export function termsChangedLine(focus: string): HTMLElement {
  const notice = line("warn", "alert", TERMS_CHANGED)
  notice.tabIndex = -1
  notice.dataset.focus = focus
  return notice
}

export const termsBox = (a: Agreement, agree: (agreed: boolean) => void, focus: string, accept?: (accepted: boolean) => void) =>
  el("div", { class: "mid" }, a.changed ? termsChangedLine(focus) : null, termsChecks(a, agree, accept))
