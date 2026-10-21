// The link field that the Links step and Edit links share: one field for either kind of link, each checked as it is typed and
// shown with its profile, and a second field for the other kind once the first holds a link.
import * as api from "../api.ts"
import { el, icon, link, refill, waitOut } from "../dom.ts"
import { type LinkKind, linkKind, linkProblem } from "../names.ts"
import { chatButton, profileLine } from "./chats.ts"
import { inPlace, whenDropped } from "./shell.ts"

const KIND_TEXT: Record<LinkKind, { name: string; placeholder: string; add: string }> = {
  contact: { name: "Contact address", placeholder: "Paste your contact address", add: "Add a contact address" },
  channel: { name: "Channel", placeholder: "Paste your channel link", add: "Add a channel link" },
}
const ANY_LINK = { name: "Link", placeholder: "Paste a contact address or channel link" }
const linkName = (kind: LinkKind) => KIND_TEXT[kind].name
const otherKind = (kind: LinkKind): LinkKind => kind === "contact" ? "channel" : "contact"

let linkFields = 0
// a link's profile as shown, so a field or a review drawn again for it shows it at once
const previews = new Map<string, api.Profile>()
const PREVIEW_RETRY_S = 3

// a preview's place is held while it is asked for, so the page is laid out at its height from the start
const previewPlace = () => el("div", { class: "entity skeleton", "aria-hidden": "true" })

function linkPreview(link: string, withKind = false): HTMLElement {
  const known = previews.get(link)
  if (known) return profileLine(known, withKind)
  const place = previewPlace()
  void api.previewLink(link).then((profile) => {
    previews.set(link, profile)
    place.replaceWith(inPlace(profileLine(profile, withKind)))
  }, () => place.replaceWith(el("span", { class: "raw" }, link)))
  return place
}

// The chat a link opens, as the search's answer draws it, opening its popup; its place is held while its profile is asked for.
export function linkChat(link: string, name: string, key: string): HTMLElement {
  const button = (p: api.Profile) => chatButton({ ...p, link, deepLink: link }, name, key)
  const known = previews.get(link)
  if (known) return button(known)
  const place = el("span", { class: "chat skeleton", "aria-hidden": "true" })
  void api.previewLink(link).then((p) => {
    previews.set(link, p)
    place.replaceWith(inPlace(button(p)))
  }, () => place.remove())
  return place
}

// What a field takes: a link of its kind, or of either kind, less a kind another field holds; `fieldOf` names the field for a kind.
interface Takes { kind: LinkKind | null; refused: () => LinkKind | null; fieldOf: (kind: LinkKind) => string }

// data-state is "ok", "bad", "checking" or "empty"; save hears each good link with its kind and the field emptied, never one checked or refused.
function linkField(takes: Takes, value: string, save: (v: string, kind: LinkKind | null) => void): HTMLElement {
  const errorId = `link-error-${++linkFields}`
  const text = takes.kind ? KIND_TEXT[takes.kind] : ANY_LINK
  const input = el("input", { type: "text", placeholder: text.placeholder, value, "aria-label": text.name, spellcheck: "false", autocomplete: "off",
    "data-focus": `link-${takes.kind ?? "any"}` })
  // the profile a link opens shows at the field's end, and what is wrong with a link under it
  const preview = el("span", { class: "preview" })
  const unlink = el("button", { class: "unlink", type: "button", "aria-label": "Remove link", onclick: () => {
    input.value = ""
    input.dispatchEvent(new Event("input"))
    input.focus()
  } }, icon("close"))
  // an empty field offers the link copied in the app, where the browser lets the page read what was copied
  const paste = navigator.clipboard?.readText ? el("button", { class: "field-copy paste", type: "button", onclick: () => {
    navigator.clipboard.readText().then((text) => {
      input.value = text.trim()
      input.dispatchEvent(new Event("input"))
    }, () => undefined).finally(() => input.focus())
  } }, "Paste") : null
  const box = el("label", { class: "field" }, icon("link"), input, preview, paste, unlink)
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
      save("", null)
      return show(null)
    }
    const kind = takes.kind ?? linkKind(link)
    const accept = () => {
      field.dataset.state = "ok"
      box.className = "field ok"
      save(link, kind)
    }
    const known = previews.get(link)
    // the value the field opened with, or the chain's given since, is kept as it is, even several links or one whose preview fails
    const kept = field.dataset.kept ?? value
    if (link === kept) {
      accept()
      return kept.includes(";") ? show(null, el("p", { class: "note" }, "Several links. SimpleX opens the first one.")) : show(linkPreview(link, true))
    }
    const problem = kind ? linkProblem(kind, link) : "kind"
    const held = kind !== null && kind === takes.refused() ? kind : null
    if (problem || held) {
      const other = held ?? linkKind(link)
      return refuse(problem === "long" ? "This link is too long."
        : other ? `This is a ${linkName(other).toLowerCase()} link: paste it in the ${takes.fieldOf(other)} field.`
        : takes.kind ? `Paste a SimpleX ${linkName(takes.kind).toLowerCase()} short link.` : "Paste a SimpleX contact address or channel short link.")
    }
    if (known) {
      accept()
      return show(profileLine(known, true))
    }
    holdPreviewPlace()
    try {
      const profile = await api.previewLink(link)
      previews.set(link, profile)
      if (mine !== seq || !shown() || !field.isConnected) return
      accept()
      show(inPlace(profileLine(profile, true)))
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
  // the link is left at its start, where focus brings it back, as a browser shows a field from its last caret and scroll
  input.addEventListener("blur", () => { input.setSelectionRange(0, 0); input.scrollLeft = 0 })
  field.dataset.state = "empty"
  if (value) void check()
  return field
}

export interface LinkFields {
  node: HTMLElement
  fields: () => HTMLElement[]
  // puts a link the chain holds into the field for its kind, as the field's own
  show: (kind: LinkKind, link: string) => void
}

// One field takes a link of either kind; once it holds one, a text link adds a field for the other kind. `save` hears
// each kind's link as it changes, and nothing for the links the fields open with.
export function linkFieldsFor(links: api.Links, save: (kind: LinkKind, link: string) => void): LinkFields {
  const first: LinkKind = links.contact || !links.channel ? "contact" : "channel"
  // the kind the first field holds, and the second field's, once added
  let held: LinkKind | null = links[first] ? first : null
  let second: { kind: LinkKind; field: HTMLElement } | null = null
  let opening = true
  const told = (kind: LinkKind, link: string) => { if (!opening) save(kind, link) }
  const fieldOf = (kind: LinkKind) => second?.kind === kind ? linkName(kind) : ANY_LINK.name
  const add = link("", () => addSecond(otherKind(held!), "", true))
  const node = el("div", { class: "link-fields" })
  const offerAdd = () => {
    add.hidden = held === null || second !== null
    if (held) add.textContent = KIND_TEXT[otherKind(held)].add
  }
  const firstField = linkField({ kind: null, refused: () => second?.kind ?? null, fieldOf }, links[first], (value, kind) => {
    if (held && held !== kind) told(held, "")
    if (kind) told(kind, value)
    held = kind ?? (second ? held : null)
    offerAdd()
  })
  const addSecond = (kind: LinkKind, value: string, focus: boolean) => {
    const field = linkField({ kind, refused: () => null, fieldOf }, value, (v) => told(kind, v))
    second = { kind, field }
    add.before(field)
    offerAdd()
    if (focus) field.querySelector("input")!.focus()
  }
  node.append(firstField, add)
  if (links.contact && links.channel) addSecond("channel", links.channel, false)
  offerAdd()
  opening = false
  const fieldFor = (kind: LinkKind) => second?.kind === kind ? second.field : held === kind || held === null ? firstField : null
  return {
    node,
    fields: () => [firstField, ...(second ? [second.field] : [])],
    show: (kind, value) => {
      let field = fieldFor(kind)
      if (!field) {
        if (!value) return
        addSecond(kind, value, false)
        field = second!.field
      }
      const input = field.querySelector("input")!
      if (input.value === value) return
      field.dataset.kept = value
      input.value = value
      input.dispatchEvent(new Event("input", { bubbles: true }))
    },
  }
}

export function focusUnsettled(fields: HTMLElement[]): boolean {
  const unsettled = fields.find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
  unsettled?.querySelector("input")!.focus()
  return unsettled !== undefined
}
