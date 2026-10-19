// Search: the hero, the search box and every answer it can show, then how it works.
import * as api from "../api.ts"
import { labelHash } from "../crypto/registration.ts"
import { checksumAddress, fromHex, hex } from "../crypto/wallet.ts"
import { alertBox, btn, chip, el, icon, link, nameText, nameTitle, reducedMotion, setAction, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { dollars, letters, methodName, shortAddress, termText } from "../format.ts"
import { methodMark, wefunderMark } from "../icons.ts"
import { foldLabel, MAX_LABEL_LENGTH, priceFor } from "../names.ts"
import type { Hold } from "../screens/hold.ts"
import { againLine, ranOut } from "../screens/names.ts"
import {
  type Answer, codeFor, initialSearch, type Mine, type Moved, type Opening, reduce, returnedTo, screenOf, searchDue, type SearchEvent, type SearchKind, type SearchState,
} from "../screens/search.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { codePopup } from "./codes.ts"
import { type Builder, closePopup, CONTACT_EMAIL, currentRoute, draw, go, INVEST_LINE, isRedraw, isRoute, kept, keptLive, outcome, popup, searchLink, throughHistory, WEFUNDER_URL } from "./shell.ts"
import { after } from "./effects.ts"
import { holdEnd, holdEnder, holdFrom, holdNotice, secondsLeft, tabHold } from "./hold.ts"

// links from the service come from records on chain, which anyone can write: only SimpleX and https links are followed
const SAFE_LINK = /^(simplex:\/|https:\/\/)/

export const TEAM_LINK = "https://smp6.simplex.im/a#lrdvu2d8A1GumSmoKb2krQmtKhWXq-tyGpHuM7aMwsw"
// the bakery the home page's example points at, as the mock's seed name does
const PREVIEW_PROFILE = "Alice's Bakery"
const PREVIEW_NAME = "bakery.simplex"
// a search answered within this long shows no empty card while it waits
const SEARCH_CARD_AFTER_MS = 300
// the contact address the example name points at, shortened as the app shows a link: an example, not a working one
const PREVIEW_LINK = "smp.simplex.im/a#k3Rf…9aQw"
// word joiners keep "a–z" and "0–9" whole: a line may otherwise break after their dash
const RANGES = "a\u2060–\u2060z, 0\u2060–\u20609"
const RULE = `A name has 6 letters or more: ${RANGES} and single hyphens between them.`

let state: SearchState = initialSearch()
let shown: SearchKind | null = null
let opens = 0
let pageRoute = -1
let field: HTMLInputElement | null = null

export const shownSearch = (): Pick<SearchState, "fromApp" | "retarget"> | null => shown === null || shown === "status:bad-app-link" ? null : state

const onPage = (page: number) => page === opens && isRoute(pageRoute)

// An app's wallet in mixed case carries its checksum; one that fails it was damaged on the way.
function appWallet(owner: string | null): string | null {
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return null
  const hex = owner.slice(2)
  const checksummed = checksumAddress(fromHex(owner))
  const unchecked = hex === hex.toLowerCase() || hex === hex.toUpperCase()
  return unchecked || checksummed === owner ? checksummed : null
}

export function searchPage(params: URLSearchParams): void {
  const name = foldLabel(params.get("name") ?? "")
  const owner = params.get("owner")
  const fromApp = appWallet(owner)
  const retargetId = params.get("retarget")
  // an order opened from the app has no code here to sign another name with; the app chooses it
  const retargeted = retargetId ? store.orderByRegistration(retargetId) : undefined
  const retarget = retargeted?.ownerCode ? retargeted : null
  const opening: Opening = owner !== null && !fromApp ? "bad-app-link" : fromApp ? "fromApp" : retarget ? "retarget" : "plain"
  const fresh = !isRedraw() || shown === null || state.opening !== opening
  const returned = fresh && throughHistory()
  if (fresh) {
    state = returned ? returnedTo(state, opening, name) : initialSearch()
    shown = null
    opens += 1
  }
  pageRoute = currentRoute()
  dispatch({ type: "opened", opening, name, fromApp, retarget, applied: session.appliedCode(), hold: tabHold() })
  if (opening === "bad-app-link") return
  if (state.retarget) void checkRetarget(state.retarget)
  if (searchDue(state)) submit()
  else if (returned && state.answer?.kind === "found") void runSearch(state.name, state.seq)
  // WebKit scrolls a focused field into view when a web font loaded later resizes its text, so focus is taken after the fonts.
  const page = opens
  void document.fonts.ready.then(() => { if (onPage(page) && document.activeElement === document.body) field?.focus({ preventScroll: true }) })
}

function dispatch(event: SearchEvent): void {
  state = reduce(state, event)
  if (!isRoute(pageRoute)) return
  const kind = screenOf(state)
  shown = kind
  draw(kind, (signal) => BUILDERS[kind](state, signal))
}

// what is typed is shown by the field itself, so the page takes it without drawing
function typed(input: HTMLInputElement): void {
  state = reduce(state, { type: "typed", text: input.value })
  input.closest(".search")!.classList.remove("bad")
  document.querySelector<HTMLElement>("body > main .hint.keys")?.toggleAttribute("hidden", !input.value)
}

function submit(): void {
  const label = foldLabel(state.typed)
  const seq = state.seq
  dispatch({ type: "searched", label, hold: tabHold() })
  if (state.seq === seq || state.paused) return
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "")
  if (params.get("name") !== label) {
    params.set("name", label)
    history.replaceState(history.state, "", `/#/?${params}`)
  }
  if (state.searching) void runSearch(label, state.seq)
}

async function runSearch(label: string, seq: number): Promise<void> {
  const page = opens
  const awaited = () => onPage(page) && seq === state.seq
  const hash = hex(labelHash(label))
  let answer: api.SearchAnswer
  try {
    answer = await api.searchName(hash, label.length)
  } catch (e) {
    if (!awaited()) return
    if (holdFrom(e)) return dispatch({ type: "search-held", seq, until: holdEnd() })
    return dispatch({ type: "unanswered", seq })
  }
  if (!awaited()) return
  dispatch({ type: "answered", seq, label, answer, mine: mineFor(hash, answer), now: api.serviceNow() })
  if (answer.status === "available") void pointAtOwnOrder(label, hash, page)
}

function mineFor(hash: string, answer: api.SearchAnswer): Mine | null {
  if (answer.status !== "registered" || answer.owner === undefined) return null
  const owner = answer.owner.toLowerCase()
  const order = store.orders().find((o) => o.request.labelHash === hash && o.owner.toLowerCase() === owner)
  return order ? { registrationId: order.registrationId, withCode: order.ownerCode !== null } : null
}

async function pointAtOwnOrder(label: string, hash: string, page: number): Promise<void> {
  for (const o of store.orders().filter((r) => r.request.labelHash === hash && !r.cancelled)) {
    const invoice = o.invoiceId ? await api.readInvoice(o.invoiceId).catch(() => null) : null
    const reg = invoice?.registration ?? (o.invoiceId ? null : await api.readRegistration(o.registrationId).catch(() => null))
    if (!onPage(page)) return
    const open = reg !== null && (reg.phase !== "unpaid" || invoice?.status === "open")
    if (!open || ["taken", "failed", "code_issued", "registered"].includes(reg.phase)) continue
    return dispatch({ type: "own-order-seen", label, url: store.orderUrl(o) })
  }
  if (onPage(page) && state.ownOrder !== null) dispatch({ type: "own-order-seen", label, url: null })
}

async function readOrder(record: store.OrderRecord): Promise<{ view: api.RegistrationView; synced: store.OrderRecord } | null> {
  const view = await (record.invoiceId ? api.readInvoice(record.invoiceId).then((i) => i.registration) : api.readRegistration(record.registrationId)).catch(() => null)
  if (!view) return null
  return { view, synced: { ...(await flow.syncRecord(record, view) ?? record), paid: view.price } }
}

function movedOf(view: api.RegistrationView, record: store.OrderRecord): Moved | null {
  if (view.phase === "taken") return null
  const url = store.orderUrl(record)
  return view.phase === "code_issued" ? { to: "code", url } : { to: "name", url, label: record.label, tld: record.tld }
}

async function checkRetarget(record: store.OrderRecord): Promise<void> {
  const page = opens
  const read = await readOrder(record)
  if (read && onPage(page)) dispatch({ type: "retarget-read", record: read.synced, moved: movedOf(read.view, read.synced) })
}

function holdEnded(): void {
  const paused = state.paused
  dispatch({ type: "hold-ended" })
  if (paused && foldLabel(state.typed)) submit()
}

function removeCode(): void {
  session.setAppliedCode(null)
  dispatch({ type: "code-removed" })
  if (!field) return
  field.focus()
  field.setSelectionRange(field.value.length, field.value.length)
}

type Found = Extract<Answer, { kind: "found" }>
type Available = Extract<api.SearchAnswer, { status: "available" }>

function coveredBy(s: SearchState, label: string): session.AppliedCode | null {
  const code = codeFor(s)
  return code !== null && label.length >= code.minLength ? code : null
}

const unaffordable = (s: SearchState, answer: Available) => s.retarget !== null && answer.price > s.retarget.paid

function register(): void {
  const s = state
  if (s.answer?.kind !== "found" || s.answer.answer.status !== "available") return
  const { label, answer } = s.answer
  const chain = { resolver: answer.resolver, sponsor: answer.sponsor, chainId: answer.chainId, tld: answer.tld }
  if (s.retarget) return void retarget(s.retarget, label, chain)
  const code = coveredBy(s, label)
  const started = session.checkout()
  if (started && started.label === label && started.appOwner === s.fromApp && started.price === answer.price && started.chain.chainId === chain.chainId && !session.isSending(started)) {
    session.updateCheckout(label, { code, chain })
    return go("/#/checkout")
  }
  session.setCheckout({
    label, price: answer.price, chain, contact: "", channel: "", method: "btc", code, ownerCode: null, saved: false,
    appOwner: s.fromApp, appSecret: null,
  })
  go("/#/checkout")
}

async function retarget(record: store.OrderRecord, label: string, chain: session.Checkout["chain"]): Promise<void> {
  const page = opens
  dispatch({ type: "register-started" })
  try {
    await flow.retargetOrder(record, label, { contact: record.contact, channel: record.channel }, chain)
    if (onPage(page)) go(store.orderUrl(record))
  } catch (e) {
    const read = await readOrder(record)
    const limited = holdFrom(e)
    if (!onPage(page)) return
    if (read?.synced.label === label) return go(store.orderUrl(record))
    if (read && read.view.phase !== "taken") return dispatch({ type: "retarget-read", record: read.synced, moved: movedOf(read.view, read.synced) })
    if (limited) return dispatch({ type: "register-held", until: holdEnd() })
    const other = e instanceof api.ApiError && typeof e.body.invoiceId === "string" ? e.body.invoiceId : null
    dispatch({ type: "register-refused", refusal: other ? { why: "other", invoiceId: other } : { why: e instanceof api.ApiError && e.code === "name_taken" ? "taken" : "failed" } })
  }
}

const BUILDERS: Record<SearchKind, Builder<SearchState>> = {
  "search:plain": buildSearch,
  "search:fromApp": buildSearch,
  "search:retarget": buildSearch,
  "status:bad-app-link": buildBadAppLink,
}

function buildBadAppLink(s: SearchState): HTMLElement {
  return outcome({ tone: "warn", icon: "alert", title: "This link from SimpleX does not work",
    text: "The wallet it names is not a valid address. Open the link again from the app, or search here for a name owned by a wallet made in this browser.",
    action: el("a", { class: "btn quiet", href: searchLink(s.name, null) }, "Search here") })
}

function searchField(): HTMLElement {
  const input = el("input", { type: "text", placeholder: "yourname", "aria-label": "Name", autocomplete: "off", autocapitalize: "none", spellcheck: "false" })
  field = input
  const search = btn("Search", "", () => submit(), icon("arrow"))
  search.dataset.focus = "search"
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit() })
  // names are lower case, so upper case folds as it is typed; the caret stays where it was
  const fold = () => {
    const lower = input.value.toLowerCase()
    if (lower === input.value) return
    const caret = input.selectionStart
    input.value = lower
    input.setSelectionRange(caret, caret)
  }
  // a keyboard composing a character would restart and repeat it if the value changed under it
  input.addEventListener("compositionend", () => {
    fold()
    typed(input)
  })
  input.addEventListener("input", (e) => {
    if (!(e as InputEvent).isComposing) fold()
    typed(input)
  })
  return el("div", { class: "search" }, icon("search"), input, el("span", { class: "tld" }, ".simplex"), search)
}

function buildSearch(s: SearchState, signal: AbortSignal): HTMLElement {
  const box = kept("search-field", searchField)
  const input = box.querySelector("input")!
  const search = box.querySelector("button")!
  if (input.value !== s.typed) input.value = s.typed
  box.classList.toggle("bad", s.bad)
  setAction(search, false, s.paused)
  const retry = () => {
    search.focus({ preventScroll: true })
    submit()
  }
  holdEnder(signal, holdEnded)(s.hold !== null)
  if (s.searching && !s.searching.card && s.answer?.kind !== "found") {
    const seq = s.seq
    after(SEARCH_CARD_AFTER_MS, () => dispatch({ type: "card-due", seq }), signal)
  }
  const banner = s.opening === "plain" ? null : el("div", { class: "banner-slot" }, bannerOf(s))
  const hero = el("section", { class: "hero" }, el("div", { class: "wrap" },
    el("span", { class: "eyebrow" }, el("span", { class: "tag" }, "NEW"), "Names for SimpleX channels and addresses"),
    el("h1", { class: "display" }, "Own your name", el("br"), "on ", el("span", { class: "grad" }, "SimpleX")),
    el("p", { class: "lead" }, "One name for your public channel and contact address, registered to a wallet only you hold."),
    banner, box, keptLive("search-results", "results", resultsOf(s, retry, signal))))
  // a search under way dims the answer it replaces
  hero.querySelector(".result")?.classList.toggle("busy", s.searching !== null)
  return el("section", { class: "home" }, hero, s.opening === "plain" ? bento(signal) : null)
}

function bannerOf(s: SearchState): HTMLElement | null {
  if (s.fromApp) {
    return el("div", { class: "banner" }, icon("phone"), el("span", {}, el("b", {}, "Opened from SimpleX. "), `The name is registered to your app's wallet, ${shortAddress(s.fromApp)}.`))
  }
  if (s.moved) return movedBanner(s.moved)
  if (s.retarget) {
    const worth = dollars(s.retarget.paid, true)
    return el("div", { class: "banner" }, icon("wallet"), el("span", {}, el("b", {}, `Your payment is kept: ${worth}. `), `Choose another name of up to ${worth}; nothing more is charged.`))
  }
  return null
}

function movedBanner(moved: Moved): HTMLElement {
  return moved.to === "code"
    ? el("div", { class: "banner" }, icon("key"), el("span", {}, el("b", {}, "Your payment already became a code. "), el("a", { href: moved.url }, "Open it")))
    : el("div", { class: "banner" }, icon("info"), el("span", {}, el("b", {}, "Your payment already went to another name. "), el("a", { href: moved.url }, "Open ", nameText(moved.label, moved.tld))))
}

function resultsOf(s: SearchState, retry: () => void, signal: AbortSignal): HTMLElement | null {
  if (s.paused && s.hold) return pauseNotice(s.hold, signal)
  if (s.searching?.card) return el("div", { class: "skeleton result-shape" }, el("span", { class: "sr-only" }, "Searching…"))
  const answer = s.answer
  if (answer?.kind === "rule") return ruleLine(answer)
  if (answer?.kind === "unchecked") {
    return el("div", { class: "under-search" }, alertBox("warn", "alert", "This name could not be checked", "The name service did not answer."),
      el("div", { class: "mt-14" }, btn("Try again", "quiet", retry, icon("refresh"))))
  }
  if (answer?.kind === "found") return resultFor(s, answer, signal)
  const code = codeFor(s)
  if (code) {
    return el("p", { class: "hint applied" }, `Code applied: names of ${code.minLength} or more letters, for ${code.years}\u00a0years. Search a name to use it. `,
      link("Remove", removeCode))
  }
  // the field shows and hides it as it is typed in, as the page is not drawn for each key
  return el("p", { class: "hint keys", hidden: !s.typed }, "Press ", el("kbd", {}, "Enter"), " or Search")
}

function ruleLine({ label, problem }: Extract<Answer, { kind: "rule" }>): HTMLElement {
  const text = problem === "short" ? `${letters(label.length)}. ${RULE}` : problem === "long" ? `${letters(label.length)}. A name has at most ${MAX_LABEL_LENGTH}.` : `Use only ${RANGES} and single hyphens between them.`
  return el("p", { class: "rule" }, icon("alert"), text)
}

function pauseNotice(hold: Hold, signal: AbortSignal): HTMLElement {
  const title = el("b", {})
  const notice = el("div", { class: "under-search" }, el("div", { class: "notice warn" }, icon("clock"), el("div", {}, title, "Too many requests were sent from here. Searching is paused until then.")))
  waitOut(title, secondsLeft(hold), (left) => `Try again in ${left}`, () => undefined, signal)
  return notice
}

function resultFor(s: SearchState, found: Found, signal: AbortSignal): HTMLElement {
  const { label, answer } = found
  if (answer.status === "available") return availableResult(s, label, answer, signal)
  if (answer.status === "reserved") {
    return takenResult(label, chip("Reserved", "warn", true), [
      el("p", { class: "note" }, "Reserved names are not sold here. If it is yours to use, contact the SimpleX team."),
      el("div", { class: "mt-12" }, btn("Contact the SimpleX team", "quiet", () => teamPopup())),
    ])
  }
  // there are no renewals, so a name of ours past its expiry is over here, though the chain keeps it ours in its grace period
  const expiresAt = answer.expiresAt ?? null
  const lapsed = found.mine && expiresAt !== null && expiresAt < found.now / 1000 ? `${ranOut(expiresAt)} ${againLine(expiresAt, answer, found.now)}` : null
  return registeredResult(label, answer, found.mine, lapsed)
}

function registeredResult(label: string, answer: Extract<api.SearchAnswer, { status: "registered" }>, mine: Mine | null, lapsed: string | null): HTMLElement {
  // a name whose registration is being mined has no owner on chain yet
  const state = mine ? (lapsed ? chip("Expired", "bad") : chip("Yours", "ok", true)) : answer.owner === undefined ? chip("Being registered", "brand", true) : chip("Taken", "bad", true)
  // links kept by another resolver, or of a name that has expired, are not edited here, as Your names does not offer to
  const editing = mine && mine.withCode && answer.records !== null && !lapsed
  const yours = mine ? [el("div", { class: "yours" }, el("a", { href: "/#/names" }, "Your names"),
    editing ? el("a", { href: `/#/edit/${mine.registrationId}` }, "Edit links") : null)] : []
  if (answer.entities.length === 0) {
    const note = lapsed ?? (answer.owner === undefined ? "Someone is registering it right now. Its owner and links show once it is on chain." : "Registered, and not pointing at any address or channel that we know of yet.")
    return takenResult(label, state, [el("p", { class: "note" }, note), ...yours])
  }
  return takenResult(label, state, [
    ...(lapsed ? [el("p", { class: "note" }, lapsed)] : []),
    el("span", { class: "label" }, "Used by"),
    el("div", { class: "entities" }, ...answer.entities.map((e) => entityCard(e))),
    ...yours,
  ])
}

function availableResult(s: SearchState, label: string, answer: Available, signal: AbortSignal): HTMLElement {
  const applied = codeFor(s)
  const coded = coveredBy(s, label)
  const retarget = s.retarget
  const affordable = !unaffordable(s, answer)
  const years = coded ? coded.years : answer.years
  const meta = el("div", { class: "meta" },
    chip("Available", "ok", true), chip(`${label.length} letters`), chip(termText(years)),
    coded ? chip("Code applied", "brand") : null, retarget && affordable ? chip("Covered by your payment", "brand") : null)
  const what = el("div", { class: "what" }, nameTitle(label, "name order-name", answer.tld), meta,
    coded ? el("div", { class: "covered" }, "Covered by your code", el("span", { class: "mono nowrap" }, `${coded.display.slice(0, 9)}…`), el("span", { class: "then" }, "·", link("Remove", removeCode))) : null,
    applied && !coded ? el("div", { class: "covered" }, `Your code covers names of ${applied.minLength} or more letters.`) : null,
    retarget && !affordable ? el("div", { class: "covered" }, `This name costs more than the ${dollars(retarget.paid, true)} your order is worth.`) : null)
  const price = coded
    ? el("div", { class: "price" }, el("b", {}, el("s", {}, dollars(priceFor(answer.price, years, answer.years))), "$0"), el("span", {}, `for ${years} years`))
    : el("div", { class: "price" }, el("b", {}, dollars(answer.price)), el("span", {}, `for ${years} years`))
  const action = coded ? "Register with code" : retarget ? "Register with your payment" : "Register"
  const unpayable = unaffordable(s, answer)
  const button = setAction(btn(action, "", register, icon("arrow")), s.register.busy, unpayable || s.ownOrder !== null || s.hold !== null)
  return el("div", {}, el("div", { class: "result" }, what, el("div", { class: "deal" }, price, button)), el("div", { class: "under-search" }, registerNote(s, unpayable, signal)))
}

function registerNote(s: SearchState, unpayable: boolean, signal: AbortSignal): HTMLElement | null {
  const { ownOrder, hold, register: { refusal } } = s
  if (unpayable) return null
  if (ownOrder) return ownOrderNote(ownOrder)
  if (hold) return holdNotice(hold, signal)
  if (!refusal) return null
  if (refusal.why === "other") return ownOrderNote(store.invoiceUrl(refusal.invoiceId))
  const words = refusal.why === "taken" ? "This name was taken just now. Search another one." : "Nothing changed. Try again in a moment."
  return alertBox("danger", "alert", "That did not go through", words)
}

const ownOrderNote = (url: string) => alertBox("info", "info", "You already have an order for this name", el("a", { href: url }, "Open that order"))

function takenResult(label: string, chipNode: HTMLElement, below: Node[]): HTMLElement {
  return el("div", { class: "result stack" },
    el("div", { class: "result-top" }, el("div", { class: "what" }, nameTitle(label, "name order-name"), el("div", { class: "meta" }, chipNode))),
    el("div", { class: "below" }, ...below))
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"
}

function hue(text: string): number {
  let h = 0
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

// A profile without a picture shows its initials on its name's colour, the same wherever it is drawn. One lightness for
// every hue keeps white initials at 4.5:1 or more once the browser fits the colour into sRGB, which 55% did not for greens.
function initialsAvatar(displayName: string): HTMLElement {
  const avatar = el("span", { class: "avatar" }, initials(displayName))
  avatar.style.background = `oklch(52% 0.15 ${hue(displayName)})`
  return avatar
}

export function entityCard(e: { type: "address" | "channel"; displayName: string; image: string | null; link: string; deepLink?: string }, openable = true): HTMLElement {
  const avatar = e.image ? el("img", { class: "avatar", src: e.image, alt: "" }) : initialsAvatar(e.displayName)
  return el("div", { class: "entity" },
    avatar,
    el("div", { class: "who" }, el("b", { title: e.displayName }, e.displayName), el("span", {}, e.type === "address" ? "Contact address" : "Channel")),
    el("span", { class: "url" }, e.link),
    openable && e.deepLink && SAFE_LINK.test(e.deepLink) ? el("a", { href: e.deepLink }, "Open in SimpleX") : null)
}

export function teamPopup(): void {
  popup(el("div", { class: "modal", role: "dialog", "aria-label": "Contact the SimpleX team" },
    el("div", { class: "modal-head" }, el("h3", {}, "Own a trademark?"),
      el("a", { class: "icon-btn", href: "#", role: "button", "aria-label": "Close", onclick: (e: Event) => { e.preventDefault(); closePopup() } }, icon("x"))),
    el("p", { class: "sec-note" }, "You can reserve the matching SimpleX name. Email us at ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL),
      " or ", el("a", { href: TEAM_LINK, target: "_blank", rel: "noopener" }, "connect in the SimpleX Chat app"), ".")))
}

const SCENE_TYPE_MS = 80
const SCENE_STEP_MS = 550
const SCENE_HOLD_MS = 2600
const SCENE_OUT_MS = 350
const SCENE_PLAYS = 3
let scenePlayed = false

// a reader who asks for less motion sees the scene's last frame at once
function playWhenSeen(scene: HTMLElement, signal: AbortSignal): HTMLElement {
  if (scenePlayed || reducedMotion() || signal.aborted) return scene
  scene.dataset.step = "empty"
  scene.querySelector(".nm")!.textContent = ""
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return
    seen.disconnect()
    if (!scenePlayed) void playScene(scene)
  }, { threshold: 0.6 })
  seen.observe(scene)
  signal.addEventListener("abort", () => seen.disconnect(), { once: true })
  return scene
}

async function playScene(scene: HTMLElement): Promise<void> {
  scenePlayed = true
  const name = scene.querySelector<HTMLElement>(".nm")!
  const typed = scene.querySelector<HTMLElement>(".typed")!
  const wait = (ms: number) => new Promise<boolean>((resolve) => setTimeout(() => resolve(scene.isConnected), ms))
  name.textContent = PREVIEW_NAME
  typed.style.width = `${typed.getBoundingClientRect().width}px`
  for (let play = 0; play < SCENE_PLAYS; play++) {
    scene.dataset.step = "empty"
    name.textContent = ""
    typed.classList.add("typing")
    for (const ch of PREVIEW_NAME) {
      if (!await wait(SCENE_TYPE_MS)) return
      name.textContent += ch
    }
    typed.classList.remove("typing")
    if (!await wait(SCENE_STEP_MS / 2)) return
    scene.dataset.step = "opens"
    if (!await wait(SCENE_STEP_MS)) return
    delete scene.dataset.step
    if (play === SCENE_PLAYS - 1) break
    if (!await wait(SCENE_HOLD_MS)) return
    scene.dataset.step = "out"
    if (!await wait(SCENE_OUT_MS)) return
  }
  typed.style.removeProperty("width")
}

function bento(signal: AbortSignal): HTMLElement {
  const step = (n: string, title: string, text: string, extra: Node | null = null) =>
    el("article", { class: "tile" }, el("span", { class: "n" }, n), el("h3", {}, title), el("p", {}, text), extra)
  return el("section", { class: "section" }, el("div", { class: "wrap" },
    el("div", { class: "section-head" }, el("h2", { class: "display" }, "How it works")),
    el("div", { class: "bento" },
      step("1", "Search", `Any name of 6 letters or more: ${RANGES} and single hyphens between them. The search sends only its hash and length.`),
      step("2", "Pay", "One price for 2 years, shown with the name, and 30 more days free.",
        el("div", { class: "pays" }, ...(["card", "btc", "xmr"] as const).map((m) => el("span", {}, methodMark(m), methodName(m))))),
      step("3", "It's yours", "Registered to a wallet made in your browser. Its name code is the only key, and moves the name to your app."),
      el("article", { class: "tile wide showcase" },
        el("h3", {}, "One name, wherever people find you"),
        el("p", {}, "Point it at your contact address and your channel. People type the name in SimpleX and connect."),
        playWhenSeen(el("div", { class: "scene", "aria-hidden": "true" },
          el("span", { class: "typed" }, icon("search"), el("span", { class: "nm grad" }, PREVIEW_NAME)),
          el("span", { class: "opens" }, el("span", { class: "word" }, "opens"), el("i", { class: "line" })),
          el("div", { class: "contact" }, initialsAvatar(PREVIEW_PROFILE),
            el("div", { class: "who" }, el("b", {}, PREVIEW_PROFILE), el("span", { class: "mono" }, PREVIEW_LINK)))), signal)),
      el("article", { class: "tile invest" },
        el("h3", {}, "Investors get a name free"),
        el("p", {}, INVEST_LINE),
        el("div", { class: "links" },
          el("a", { class: "wefunder-btn", href: WEFUNDER_URL, target: "_blank", rel: "noopener", "aria-label": "Learn more on Wefunder" }, "Learn more on", wefunderMark()),
          el("a", { class: "check-code-btn", href: "#", role: "button", onclick: (e: Event) => { e.preventDefault(); codePopup() } }, "Check your code"))))))
}
