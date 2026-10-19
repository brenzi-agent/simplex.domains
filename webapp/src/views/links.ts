// The link fields that the Links step and Edit links share, each checked as it is typed and shown with its preview.
import * as api from "../api.ts"
import { el, icon, refill, waitOut } from "../dom.ts"
import { type LinkKind, linkKind, linkProblem } from "../names.ts"
import { entityCard } from "./search.ts"
import { whenDropped } from "./shell.ts"

const FIELD_TEXT: Record<LinkKind, { name: string; placeholder: string }> = {
  contact: { name: "Contact address", placeholder: "Paste your address" },
  channel: { name: "Channel", placeholder: "Paste your channel" },
}
export const linkName = (kind: LinkKind) => FIELD_TEXT[kind].name

let linkFields = 0
type Preview = Awaited<ReturnType<typeof api.previewLink>>
// a link's profile as shown, so a field or a review drawn again for it shows it at once
const previews = new Map<string, Preview>()
const PREVIEW_RETRY_S = 3

// a preview's place is held while it is asked for, so the page is laid out at its height from the start
const previewPlace = () => el("div", { class: "entity skeleton", "aria-hidden": "true" })

export function linkPreview(link: string): HTMLElement {
  const known = previews.get(link)
  if (known) return entityCard(known)
  const place = previewPlace()
  void api.previewLink(link).then((profile) => {
    previews.set(link, profile)
    place.replaceWith(entityCard(profile))
  }, () => place.replaceWith(el("span", {}, link)))
  return place
}

// The field's data-state says whether its link is "ok", "bad", or "empty". save hears each link that is ok and the field
// emptied; a link being checked or refused leaves the last one saved.
export function linkField(kind: LinkKind, value: string, save: (v: string) => void): HTMLElement {
  const errorId = `link-error-${++linkFields}`
  const input = el("input", { type: "text", placeholder: FIELD_TEXT[kind].placeholder, value, "aria-label": FIELD_TEXT[kind].name, spellcheck: "false", autocomplete: "off",
    "data-focus": `link-${kind}` })
  // the profile a link opens shows at the field's end, and what is wrong with a link under it
  const preview = el("span", { class: "preview" })
  const box = el("label", { class: "field" }, icon("link"), input, preview)
  const card = el("div", {})
  const field = el("div", { class: "link-field" }, box, card)
  const show = (inField: Node | null, below: Node | null = null) => {
    refill(preview, inField)
    refill(card, below)
  }
  // the field lives as long as the route keeps it; a check started anew ends the last one's wait
  const life = new AbortController()
  let waiting = new AbortController()
  whenDropped(() => { life.abort(); waiting.abort() })
  const shown = () => !life.signal.aborted
  let seq = 0
  const holdPreviewPlace = () => show(preview.querySelector(".skeleton") ?? previewPlace())
  const refuse = (text: string) => {
    box.className = "field bad"
    field.dataset.state = "bad"
    input.setAttribute("aria-invalid", "true")
    input.setAttribute("aria-describedby", errorId)
    // the same refusal again, as typing on in a refused link gives, keeps still
    if (card.querySelector(".field-error")?.textContent !== text) show(null, el("p", { class: "field-error", id: errorId }, icon("alert"), text))
  }
  const check = async () => {
    const mine = ++seq
    waiting.abort()
    waiting = new AbortController()
    const link = input.value.trim()
    box.className = "field"
    input.removeAttribute("aria-invalid")
    input.removeAttribute("aria-describedby")
    field.dataset.state = link ? "checking" : "empty"
    if (!link) {
      save("")
      return show(null)
    }
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
      return kept.includes(";") ? show(null, el("p", { class: "note" }, "Several links. SimpleX opens the first one.")) : show(linkPreview(link))
    }
    const problem = linkProblem(kind, link)
    if (problem) {
      const other = linkKind(link)
      return refuse(problem === "long" ? "This link is too long."
        : other ? `This is a ${linkName(other).toLowerCase()} link: paste it in the ${linkName(other)} field.`
        : `Paste a SimpleX ${linkName(kind).toLowerCase()} short link.`)
    }
    if (known) {
      accept()
      return show(entityCard(known))
    }
    holdPreviewPlace()
    try {
      const profile = await api.previewLink(link)
      previews.set(link, profile)
      if (mine !== seq || !shown() || !field.isConnected) return
      accept()
      show(entityCard(profile))
    } catch (e) {
      if (mine !== seq || !shown() || !field.isConnected) return
      // the service refusing the link is about the link; a rate limit or no answer is not, and the field checks again
      if (!(e instanceof api.ApiError) || e.code === "network" || e.code === "rate_limited" || e.status >= 500) {
        const line = el("span", {})
        const notice = el("p", { class: "field-error", id: errorId }, icon("clock"), line)
        input.setAttribute("aria-describedby", errorId)
        waitOut(line, e instanceof api.ApiError && e.retryAfter ? e.retryAfter : PREVIEW_RETRY_S,
          (left) => `The link could not be checked now. Checking again in ${left}.`, () => { if (mine === seq) void check() }, waiting.signal)
        return show(null, notice)
      }
      refuse("This link could not be opened.")
    }
  }
  input.addEventListener("input", () => void check())
  field.dataset.state = "empty"
  if (value) void check()
  return field
}

export const linkEntry = (kind: LinkKind, field: HTMLElement) => el("div", { class: "link-entry" }, el("span", { class: "label" }, linkName(kind)), field)

export function focusUnsettled(fields: HTMLElement[]): boolean {
  const unsettled = fields.find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
  unsettled?.querySelector("input")!.focus()
  return unsettled !== undefined
}
