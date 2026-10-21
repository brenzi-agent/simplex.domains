// The home: the landing's headline, the search box and every answer it can show, and the invest popup.
import * as api from "../api.ts"
import { labelHash } from "../crypto/registration.ts"
import { checksumAddress, fromHex, hex } from "../crypto/wallet.ts"
import { alertBox, btn, el, icon, type Kid, link, nameText, nameTitle, setAction, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { dollars, letters, shortAddress } from "../format.ts"
import type { IconName } from "../icons.ts"
import { foldLabel, MAX_LABEL_LENGTH } from "../names.ts"
import type { Hold } from "../screens/hold.ts"
import { againLine, ranOut } from "../screens/names.ts"
import { checkoutUrl } from "../screens/routes.ts"
import {
  type Answer, initialSearch, type Moved, type Opening, reduce, returnedTo, screenOf, searchDue, type SearchEvent, type SearchKind, type SearchState,
} from "../screens/search.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { asStep, type Builder, CONTACT_EMAIL, currentRoute, draw, go, historyPlace, isRedraw, isRoute, kept, keptLive, outcome, searchLink, throughHistory } from "./shell.ts"
import { chatButton } from "./chats.ts"
import { holdEnd, holdEnder, holdFrom, holdNotice, secondsLeft, tabHold } from "./hold.ts"

// word joiners keep "a–z" and "0–9" whole: a line may otherwise break after their dash
const RANGES = "a\u2060–\u2060z, 0\u2060–\u20609"
const RULE = `A name has 6 letters or more: ${RANGES} and single hyphens between them.`

// the landing's words (simplex.domains index.html:287-288)
const HEADLINE = "Your SimpleX domain"
const SUB = "One name for your public channel and contact address"

let state: SearchState = initialSearch()
let shown: SearchKind | null = null
let opens = 0
let pageRoute = -1
let field: HTMLInputElement | null = null

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
    state = returned ? returnedTo(state, opening, name, store.orders()) : initialSearch()
    shown = null
    opens += 1
  }
  pageRoute = currentRoute()
  dispatch({ type: "opened", opening, name, fromApp, retarget, hold: tabHold() })
  if (opening === "bad-app-link") return
  if (state.retarget) void checkRetarget(state.retarget)
  if (searchDue(state)) submit()
  else if (returned && state.answer) void runSearch(state.name, state.seq)
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
  input.closest(".field")!.classList.remove("bad")
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

function mineFor(hash: string, answer: api.SearchAnswer): boolean {
  if (answer.status !== "registered" || answer.owner === undefined) return false
  const owner = answer.owner.toLowerCase()
  return store.orders().some((o) => o.request.labelHash === hash && o.owner.toLowerCase() === owner)
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

// a search the wait paused is sent once it ends; one already on its way, as Back sends, is not sent again
function holdEnded(): void {
  const paused = state.paused
  dispatch({ type: "hold-ended" })
  if (paused && state.answer?.kind === "checking") submit()
}

type Found = Extract<Answer, { kind: "found" }>
type Available = Extract<api.SearchAnswer, { status: "available" }>

const unaffordable = (s: SearchState, answer: Available) => s.retarget !== null && answer.price > s.retarget.paid
// an order this browser has for the name, which the search found or the service named in refusing a second one
const ownOrderOf = ({ ownOrder, register: { refusal } }: SearchState) => ownOrder ?? (refusal?.why === "other" ? store.invoiceUrl(refusal.invoiceId) : null)

function register(): void {
  const s = state
  if (s.answer?.kind !== "found" || s.answer.answer.status !== "available") return
  const { label, answer } = s.answer
  const chain = { resolver: answer.resolver, sponsor: answer.sponsor, chainId: answer.chainId, tld: answer.tld }
  if (s.retarget) return void retarget(s.retarget, label, chain)
  const code = codeFor(s, label)
  const started = session.checkout()
  if (started && started.label === label && started.appOwner === s.fromApp && started.price === answer.price && started.chain.chainId === chain.chainId && !session.isSending(started)) {
    session.updateCheckout(label, { chain, searchAt: historyPlace(), code, codeError: undefined })
    return go(checkoutUrl("links"))
  }
  session.setCheckout({
    label, price: answer.price, chain, contact: "", channel: "", method: "btc", code, ownerCode: null, saved: false,
    appOwner: s.fromApp, appSecret: null, searchAt: historyPlace(), step: "links",
  })
  go(checkoutUrl("links"))
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
  return asStep(outcome({ tone: "warn", icon: "alert", title: "This link from SimpleX does not work",
    text: "The wallet it names is not a valid address. Open the link again from the app, or search here for a name owned by a wallet made in this browser.",
    action: el("a", { class: "btn quiet", href: searchLink(s.name, null) }, "Search here") }))
}

function searchBox(): HTMLElement {
  const input = el("input", { type: "text", placeholder: "yourname", "aria-label": "Name", autocomplete: "off", autocapitalize: "none", spellcheck: "false" })
  field = input
  const search = el("button", { class: "btn lens", type: "button", "aria-label": "Search", "data-focus": "search", onclick: () => submit() }, icon("search"))
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
  return el("label", { class: "field search-field" }, input, el("span", { class: "tld" }, ".simplex"), search)
}

function buildSearch(s: SearchState, signal: AbortSignal): HTMLElement {
  const box = kept("search-field", searchBox)
  const input = box.querySelector("input")!
  const search = box.querySelector("button")!
  if (input.value !== s.typed) input.value = s.typed
  box.classList.toggle("bad", s.bad)
  search.disabled = s.paused
  if (s.searching) search.setAttribute("aria-busy", "true")
  else search.removeAttribute("aria-busy")
  const retry = () => {
    search.focus({ preventScroll: true })
    submit()
  }
  holdEnder(signal, holdEnded)(s.hold !== null)
  // the answer's room is kept from the start, so the headline and the field never move as an answer comes
  return el("section", { class: "home" },
    el("h1", {}, HEADLINE), el("p", { class: "sub" }, SUB),
    openingLine(s),
    el("div", { class: "search" }, box, keptLive("search-answer", "answer", answerOf(s, retry, signal))))
}

function openingLine(s: SearchState): HTMLElement | null {
  if (s.fromApp) return alertBox("info", "phone", "Opened from SimpleX.", `The name is registered to your app's wallet, ${shortAddress(s.fromApp)}.`)
  if (s.moved?.to === "code") return alertBox("info", "key", "Your payment already became a code.", el("a", { href: s.moved.url }, "Open it"))
  if (s.moved) return alertBox("info", "info", "Your payment already went to another name.", el("a", { href: s.moved.url }, "Open ", nameText(s.moved.label, s.moved.tld)))
  if (!s.retarget) return null
  const worth = dollars(s.retarget.paid, true)
  return alertBox("info", "wallet", `Your payment is kept: ${worth}.`, `Choose another name of up to ${worth}; nothing more is charged.`)
}

const line = (tone: string, ic: IconName, ...text: Kid[]) => el("p", { class: `line ${tone}` }, icon(ic), el("span", {}, ...text))

function answerOf(s: SearchState, retry: () => void, signal: AbortSignal): Kid {
  if (s.paused && s.hold) return pauseLine(s.hold, signal)
  const answer = s.answer
  if (answer?.kind === "rule") return ruleLine(answer)
  if (answer?.kind === "unchecked") return line("warn", "alert", "This name could not be checked. ", link("Try again", retry))
  if (answer?.kind !== "found") return answer?.kind === "checking" ? line("", "clock", "Checking the name…") : null
  const found = answer.answer
  if (found.status === "available") return availableAnswer(s, answer.label, found, signal)
  if (found.status === "reserved") {
    return line("info", "info", "Reserved names are not sold here. If it is yours to use, write to ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), ".")
  }
  return takenAnswer(answer, found)
}

function ruleLine({ label, problem }: Extract<Answer, { kind: "rule" }>): HTMLElement {
  const text = problem === "short" ? `${letters(label.length)}. ${RULE}` : problem === "long" ? `${letters(label.length)}. A name has at most ${MAX_LABEL_LENGTH}.` : `Use only ${RANGES} and single hyphens between them.`
  return line("bad", "alert", text)
}

function pauseLine(hold: Hold, signal: AbortSignal): HTMLElement {
  const count = el("span", {})
  const node = el("p", { class: "line warn" }, icon("clock"), count)
  waitOut(count, secondsLeft(hold), (left) => `Searching is paused: try again in ${left}.`, () => undefined, signal)
  return node
}

// the tab's active code pays for a name it covers; a name opened from the app, or a paid order's move, pays its own way
const usesCode = (s: SearchState) => s.fromApp === null && s.retarget === null
const codeFor = (s: SearchState, label: string) => {
  const code = session.activeCode()
  return code && usesCode(s) && label.length >= code.minLength ? code : null
}

function availableAnswer(s: SearchState, label: string, answer: Available, signal: AbortSignal): Kid[] {
  const retarget = s.retarget
  const unpayable = unaffordable(s, answer)
  const covers = retarget && (unpayable ? `This name costs more than the ${dollars(retarget.paid, true)} your order is worth.` : "Covered by your payment")
  const own = ownOrderOf(s)
  const code = codeFor(s, label)
  const short = usesCode(s) ? session.activeCode() : null
  const button = setAction(btn(retarget ? "Register with your payment" : "Register", "small", register), s.register.busy, unpayable || own !== null || s.hold !== null)
  const deal = code ? [el("s", {}, dollars(answer.price)), " ", el("b", { class: "price" }, "$0"), el("span", { class: "soft" }, ` / ${code.years} years`)]
    : [el("b", { class: "price" }, dollars(answer.price)), el("span", { class: "soft" }, ` / ${answer.years} years`)]
  return [
    el("div", { class: "card row buy" }, nameTitle(label, "name", answer.tld), el("span", { class: "deal" }, deal), button),
    !code && short ? el("p", { class: "hint" }, `Your code covers names of ${short.minLength} or more letters. `, el("span", { class: "nowrap" }, `This name has ${label.length}.`)) : null,
    covers ? line("", "wallet", covers) : null,
    own ? line("", "info", "You already have an order for this name. ", el("a", { class: "nowrap", href: own }, "Open that order")) : null,
    unpayable || own ? null : registerNote(s, signal),
  ]
}

function registerNote({ hold, register: { refusal } }: SearchState, signal: AbortSignal): HTMLElement | null {
  if (hold) return holdNotice(hold, signal)
  if (!refusal) return null
  const words = refusal.why === "taken" ? "This name is no longer available. Search another one." : "Nothing changed. Try again in a moment."
  return alertBox("danger", "alert", "That did not go through", words)
}

// One row as the app lists a chat: the name, the chats it opens as the app's own pictures, and whose it is.
function takenAnswer(found: Found, answer: Extract<api.SearchAnswer, { status: "registered" }>): Kid[] {
  const { label, mine } = found
  // there are no renewals, so a name of ours past its expiry is over here, though the chain keeps it ours in its grace period
  const expiresAt = answer.expiresAt ?? null
  const lapsed = mine && expiresAt !== null && expiresAt < found.now / 1000 ? `${ranOut(expiresAt)} ${againLine(expiresAt, answer, found.now)}` : null
  // a name whose registration is being mined has no owner on chain yet
  const registering = answer.owner === undefined
  const whose = mine ? (lapsed ? el("span", { class: "soft" }, "Expired") : el("a", { class: "nowrap", href: "/#/names" }, "Your name"))
    : el("span", { class: "soft" }, registering ? "Being registered" : "Taken")
  const name = `${label}.${answer.tld}`
  return [
    el("div", { class: "card row" }, nameTitle(label, "name", answer.tld),
      answer.entities.length ? el("span", { class: "chats" }, answer.entities.map((e, i) => chatButton(e, name, `chat-${i}`))) : null, whose),
    lapsed ? line("", "clock", lapsed) : registering ? line("", "clock", "Someone is registering it right now. Its owner and links show once it is on chain.") : null,
  ]
}
