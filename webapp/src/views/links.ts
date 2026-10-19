// The link fields that the Links step and Edit links share, each checked as it is typed and shown with its preview.
import * as api from "../api.ts"
import { el, icon, waitOut } from "../dom.ts"
import { type LinkKind, linkKind, linkProblem } from "../names.ts"
import { entityCard } from "./search.ts"
import { whenDropped } from "./shell.ts"

// The field's data-state says whether its link is "ok", "bad", or "empty"; save gets the link only when it is ok.
let linkFields = 0
type Preview = Awaited<ReturnType<typeof api.previewLink>>
// a link's profile as shown, so a field drawn again for it, as on a page opened again, shows it at once
const previews = new Map<string, Preview>()
// a link preview with no answer is asked again after this long
const PREVIEW_RETRY_S = 3

export function linkField(kind: LinkKind, placeholder: string, label: string, value: string, save: (v: string) => void): HTMLElement {
  const errorId = `link-error-${++linkFields}`
  const input = el("input", { type: "text", placeholder, value, "aria-label": label, spellcheck: "false", autocomplete: "off" })
  const box = el("label", { class: "field" }, icon("link"), input)
  const card = el("div", {})
  const field = el("div", { class: "link-field" }, box, card)
  // the field lives as long as the route keeps it; a check started anew ends the last one's wait
  const life = new AbortController()
  whenDropped(() => life.abort())
  const shown = () => !life.signal.aborted
  let waiting = new AbortController()
  let seq = 0
  // the card's place is held while the link is checked, so the page is laid out at its height from the start
  const holdCardPlace = () => {
    if (!card.querySelector(".skeleton")) card.replaceChildren(el("div", { class: "entity-wrap", "aria-hidden": "true" }, el("div", { class: "entity skeleton" })))
  }
  const refuse = (text: string) => {
    box.className = "field bad"
    field.dataset.state = "bad"
    input.setAttribute("aria-invalid", "true")
    input.setAttribute("aria-describedby", errorId)
    // the same refusal again, as typing on in a refused link gives, keeps still
    if (card.querySelector(".field-error")?.textContent !== text) card.replaceChildren(el("p", { class: "field-error", id: errorId }, icon("alert"), text))
  }
  const check = async () => {
    const mine = ++seq
    waiting.abort()
    waiting = new AbortController()
    const link = input.value.trim()
    save("")
    box.className = "field"
    input.removeAttribute("aria-invalid")
    input.removeAttribute("aria-describedby")
    field.dataset.state = link ? "checking" : "empty"
    if (!link) return card.replaceChildren()
    const entity = (profile: Preview) => el("div", { class: "entity-wrap" }, entityCard({ ...profile, link }, false))
    const accept = () => {
      field.dataset.state = "ok"
      box.className = "field ok"
      save(link)
    }
    const known = previews.get(link)
    // The value the field opened with, or one the page gave it since, as the chain has it, is kept as it is, even several
    // links set elsewhere or one whose preview fails.
    const kept = field.dataset.kept ?? value
    if (link === kept) {
      accept()
      if (kept.includes(";")) return card.replaceChildren(el("p", { class: "note" }, "Several links. SimpleX opens the first one."))
      if (known) return card.replaceChildren(entity(known))
      holdCardPlace()
      const profile = await api.previewLink(link).catch(() => null)
      if (profile) previews.set(link, profile)
      if (mine === seq && shown() && field.isConnected) card.replaceChildren(profile ? entity(profile) : "")
      return
    }
    const problem = linkProblem(kind, link)
    if (problem) {
      const other = linkKind(link)
      return refuse(problem === "long" ? "This link is too long."
        : other ? `This is a ${other === "contact" ? "contact address" : "channel"} link: paste it in the ${other === "contact" ? "Address" : "Channel"} field.`
        : `Paste a SimpleX ${kind === "contact" ? "contact address" : "channel"} short link.`)
    }
    if (known) {
      accept()
      return card.replaceChildren(entity(known))
    }
    holdCardPlace()
    try {
      const profile = await api.previewLink(link)
      previews.set(link, profile)
      if (mine !== seq || !shown() || !field.isConnected) return
      accept()
      card.replaceChildren(entity(profile))
    } catch (e) {
      if (mine !== seq || !shown() || !field.isConnected) return
      // the service refusing the link is about the link; a rate limit or no answer is not, and the field checks again
      if (!(e instanceof api.ApiError) || e.code === "network" || e.code === "rate_limited" || e.status >= 500) {
        const line = el("span", {})
        const notice = el("p", { class: "field-error", id: errorId }, icon("clock"), line)
        input.setAttribute("aria-describedby", errorId)
        waitOut(line, e instanceof api.ApiError && e.retryAfter ? e.retryAfter : PREVIEW_RETRY_S,
          (left) => `The link could not be checked now. Checking again in ${left}.`, () => { if (mine === seq) void check() }, AbortSignal.any([life.signal, waiting.signal]))
        return card.replaceChildren(notice)
      }
      refuse("This link could not be opened.")
    }
  }
  input.addEventListener("input", () => void check())
  field.dataset.state = "empty"
  if (value) void check()
  return field
}

export const linkEntry = (label: string, field: HTMLElement) => el("div", { class: "link-entry" }, el("span", { class: "label" }, label), field)

export function focusUnsettled(fields: HTMLElement[]): boolean {
  const unsettled = fields.find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
  unsettled?.querySelector("input")!.focus()
  return unsettled !== undefined
}
