// Your names: this browser's orders and codes, restoring an order with its name code, and editing a name's links.
import * as api from "../api.ts"
import { parseNameCode } from "../crypto/code.ts"
import { alertBox, btn, chip, codeDisplay, copyButton, disabled, el, gradName, icon, type Kid, nameText, setAction, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { dateOf, dollars, methodName, SEP } from "../format.ts"
import type { IconName } from "../icons.ts"
import { qrSvg } from "../qr.ts"
import {
  CODE_CHIPS, EDIT_RETRY_MS, editable, type EditEvent, type EditForm, type EditKind, type EditState, hasRecords, initialEdit, initialList,
  againLine, initialRestore, lapsed, LINK_NAMES, ranOut, type EditRead, moneyReached, listedOrders, type ListEvent, type ListState, notSaved, phaseChip, reduceEdit,
  reduceList, reduceRestore, REFUSALS, type RestoreEvent, type RestoreState, type RowSeen, type CodeCheck, screenOfEdit, settled, type Stored, unsent, waitsToSign,
} from "../screens/names.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { linkField } from "./checkout.ts"
import { codeField } from "./codes.ts"
import {
  type Builder, closePopup, CONTACT_EMAIL, currentRoute, draw, drawLoading, focusOn, go, isRedraw, isRoute, kept, keptLive, popup, redirect, screen, whenDropped, whenLeaving,
} from "./shell.ts"
import { after } from "./effects.ts"
import { holdEnd, holdEnder, holdFrom, holding, holdNotice, secondsLeft, tabHold } from "./hold.ts"

const FOLLOW_MS = 15_000
const UNREAD_RETRY_MS = 5_000

function row(key: string, mark: string, title: string, sub: Kid, state: Node, ...acts: Kid[]): HTMLElement {
  return el("div", { class: "row-item", "data-key": key },
    el("span", { class: "mark" }, el("span", {}, mark)), el("div", { class: "main" }, el("b", { title }, title), el("div", { class: "sub" }, sub)), state, el("div", { class: "acts" }, ...acts))
}

// a row's action keeps focus over a redraw by its row's key and its own
const small = (text: string, key: string, onclick: () => void, ic?: IconName) =>
  el("a", { class: "small-btn", href: "#", role: "button", "data-focus": key, onclick: (e: Event) => { e.preventDefault(); onclick() } }, ic ? icon(ic) : null, text)

let list: ListState = initialList({ orders: [], pending: [], codes: [], canPersist: true }, null, {}, {}, 0)
let listShown = false
let listOpened = 0
let listRoute = -1
// the rows' follow-up reads end once the list is left, not when it is drawn again
let listStop: AbortSignal = AbortSignal.abort()
let lastSeen: Record<string, RowSeen> = {}
let lastChecked: Record<string, CodeCheck> = {}
const readFor = new Map<string, string>()
const checking = new Set<string>()
const follows = new Map<string, () => void>()

const storedNow = (): Stored => ({ orders: store.orders(), pending: store.pendingCodes(), codes: store.codes(), canPersist: store.canPersist() })
const storedEvent = (): ListEvent => ({ type: "stored", ...storedNow(), hold: tabHold() })

export function historyPage(): void {
  const mine = currentRoute()
  const stored = storedNow()
  if (!isRedraw() || !listShown) {
    listOpened += 1
    listShown = false
    const reads = new AbortController()
    listStop = reads.signal
    whenDropped(() => reads.abort())
    readFor.clear()
    checking.clear()
    follows.clear()
    list = initialList(stored, tabHold(), lastSeen, lastChecked, api.serviceNow())
  }
  listRoute = mine
  // Another tab ordering, cancelling or adding a code changes this list; the writes of one change, often several, are
  // taken once, in the next frame.
  let frame = 0
  const onStorage = (e: StorageEvent) => {
    if (!store.isRecordKey(e.key) || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      dispatchList(storedEvent())
    })
  }
  window.addEventListener("storage", onStorage)
  whenLeaving(() => {
    window.removeEventListener("storage", onStorage)
    cancelAnimationFrame(frame)
  })
  dispatchList({ type: "stored", ...stored, hold: tabHold() })
}

function dispatchList(event: ListEvent): void {
  list = reduceList(list, event)
  lastSeen = list.seen
  lastChecked = list.checked
  if (!isRoute(listRoute)) return
  listShown = true
  draw("names", (signal) => buildNames(list, signal))
  readRows()
}

const listOpen = (gen: number) => gen === listOpened && isRoute(listRoute)

function answerList(gen: number, event: ListEvent): void {
  if (listOpen(gen)) dispatchList(event)
}

function readRows(): void {
  const gen = listOpened
  for (const o of list.orders) {
    const record = JSON.stringify(o)
    if (readFor.get(o.registrationId) === record) continue
    readFor.set(o.registrationId, record)
    void readOrder(o.registrationId, gen)
  }
  for (const { code } of list.codes) {
    if (checking.has(code)) continue
    checking.add(code)
    api.checkCode(code).then((answer) => answerList(gen, { type: "code-read", code, state: answer.state }),
      (e) => answerList(gen, { type: "code-read", code, state: e instanceof api.ApiError && e.code === "code_invalid" ? "revoked" : "unchecked" }))
  }
}

async function readOrder(id: string, gen: number): Promise<void> {
  const o = list.orders.find((r) => r.registrationId === id)
  if (!o) return
  follows.get(id)?.()
  follows.delete(id)
  let view: api.RegistrationView
  let invoice: api.InvoiceView | null = null
  try {
    if (o.invoiceId) {
      invoice = await api.readInvoice(o.invoiceId)
      view = invoice.registration
    } else view = await api.readRegistration(o.registrationId)
  } catch (e) {
    // the service forgets an unpaid order some time after it closes
    if (e instanceof api.ApiError && e.code === "not_found" && await replaceWithNewer(o, gen)) return
    answerList(gen, { type: "row-unread", id })
    const wait = api.retryDelay(e, UNREAD_RETRY_MS)
    if (wait !== null && listOpen(gen)) follows.set(id, after(wait, () => void readOrder(id, gen), listStop))
    return
  }
  const synced = await flow.syncRecord(o, view) ?? o
  if (!listOpen(gen)) return
  if (synced !== o) {
    readFor.set(id, JSON.stringify(synced))
    dispatchList(storedEvent())
  }
  if (synced.replacedBy && !moneyReached(invoice)) return
  if (api.closedEmpty(invoice) && await replaceWithNewer(synced, gen)) return
  if (!listOpen(gen)) return
  dispatchList({ type: "row-read", id, view, invoice, now: api.serviceNow() })
  if (!settled(list.seen[id])) follows.set(id, after(FOLLOW_MS, () => void readOrder(id, gen), listStop))
  if (view.phase !== "registered") return
  const linksSavedAt = store.orderByRegistration(id)?.linksSavedAt
  const answer = await api.searchName(view.labelHash, (view.label ?? synced.label).length).catch(() => null)
  answerList(gen, { type: "row-answered", id, answer, linksSavedAt })
}

async function replaceWithNewer(o: store.OrderRecord, gen: number): Promise<boolean> {
  const next = !o.replacedBy && o.ownerCode ? await flow.newerOrder(o).catch(() => null) : null
  if (!next || !listOpen(gen)) return false
  dispatchList(storedEvent())
  return true
}

async function findOrder(p: store.PendingCode): Promise<void> {
  const gen = listOpened
  const { ownerCode } = p
  if (list.finding[ownerCode] === "finding" || list.hold) return
  if (holding()) return dispatchList({ type: "find-held", ownerCode, until: holdEnd() })
  dispatchList({ type: "find-started", ownerCode })
  try {
    const { record } = await flow.restore(ownerCode)
    if (listOpen(gen)) go(store.orderUrl(record))
  } catch (e) {
    if (holdFrom(e)) return answerList(gen, { type: "find-held", ownerCode, until: holdEnd() })
    answerList(gen, { type: "find-ended", ownerCode, outcome: e instanceof api.ApiError && e.code === "not_found" ? "none" : "unchecked" })
  }
}

function removePending(p: store.PendingCode): void {
  store.dropPending(p.ownerCode)
  dispatchList(storedEvent())
}

function forgetEverything(): void {
  store.forgetEverything()
  session.setCheckout(null)
  dispatchList({ type: "forget-confirmed" })
}

const pendingKey = (p: store.PendingCode) => `${p.label}@${p.createdAt}`
const leadOf = (canPersist: boolean) => canPersist ? "This list is kept only in this browser." : "This browser cannot keep this list: it empties when the page reloads."
const FORGET = "forget"
const KEEP = "keep"

function forgetPart(s: ListState): HTMLElement | null {
  if (!hasRecords(s)) return null
  if (!s.asking) {
    return el("a", { class: "danger-link", href: "#", role: "button", "data-focus": FORGET, onclick: (e: Event) => {
      e.preventDefault()
      dispatchList({ type: "forget-asked" })
      focusOn(KEEP)
    } }, "Forget everything in this browser")
  }
  const keep = btn("Keep them", "quiet", () => {
    dispatchList({ type: "forget-kept" })
    focusOn(FORGET)
  })
  keep.dataset.focus = KEEP
  return el("div", { class: "mt-18" }, alertBox("danger", "alert", "Forget every name and code in this browser?",
    "Everything listed here is removed from this browser. Without your saved copies, the name codes and codes cannot be restored."),
  el("div", { class: "actions mt-14" }, btn("Forget everything", "danger", forgetEverything), keep))
}

const ADD_CODE = "add-code"

// Your names' code field and its Add, kept across draws: Add takes a code judged unused and not listed yet.
function addCodeBox(): HTMLElement {
  let addable: session.AppliedCode | null = null
  const add = disabled(btn("Add", "quiet", () => {
    const code = addable
    if (!code) return
    store.addCode({ code: code.display, minLength: code.minLength, years: code.years, addedAt: new Date().toISOString() })
    input.value = ""
    input.dispatchEvent(new Event("input"))
    input.focus()
    dispatchList(storedEvent())
  }))
  const field = codeField(`${ADD_CODE}-field`, "Add a code", (v) => {
    const listed = v?.ok === true && store.codes().some((c) => c.code === v.code.display)
    addable = v?.ok && !listed ? v.code : null
    add.disabled = addable === null
    return listed ? "Already in your codes. It is listed under Codes in Your names." : null
  })
  const input = field.querySelector("input")!
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add.click() })
  return el("div", { class: "add-code" }, field, add)
}

function buildNames(s: ListState, signal: AbortSignal): HTMLElement {
  holdEnder(signal, () => dispatchList({ type: "hold-ended" }))(s.hold !== null)
  const orderRows = [...s.pending.map((p) => pendingRow(p, s, signal)), ...listedOrders(s).map((o) => orderRow(o, s))]
  const codeRows = s.codes.map((c) => codeRow(c, s))
  const empty = (text: string) => el("p", { class: "sec-note empty-list" }, text)
  const restoreLink = btn([icon("refresh"), "Restore with a name code"], "quiet", () => go("/#/restore"))
  restoreLink.dataset.focus = "restore-code"
  return screen({ title: "Your names", lead: leadOf(s.canPersist) },
    kept(ADD_CODE, addCodeBox),
    el("div", { class: "toolbar" }, restoreLink),
    el("div", { class: "panel" }, el("div", { class: "list-title" }, el("h2", {}, "Names")), el("div", {}, orderRows.length ? orderRows : empty("No names in this browser yet."))),
    el("div", { class: "panel mt-16" }, el("div", { class: "list-title" }, el("h2", {}, "Codes")), el("div", {}, codeRows.length ? codeRows : empty("No codes in this browser yet."))),
    forgetPart(s))
}

const markOf = (label: string) => label.slice(0, 1).toUpperCase()

const NAME_KEPT_WHOLE = 24

const PROGRESS: Partial<Record<api.Phase, string>> = {
  queued: "Paid, waiting to commit",
  committing: "Committing",
  committed: "Committed, waiting before it can register",
  registering: "Registering on chain",
}

// a row's line goes on after a separator in lower case, as "paid with a code" after the date
const continued = (text: string | null) => text ? text.charAt(0).toLowerCase() + text.slice(1) : text

// the reference support asks for, in a face where l and I differ
const reference = (id: string) => [`${SEP}reference `, el("span", { class: "mono" }, id)]

const recordedPaid = (o: store.OrderRecord) => o.method === "code" ? "Paid with a code" : `${dollars(o.paid, true)} ${methodName(o.method)}`

function subLine(o: store.OrderRecord, { view, invoice, answer }: RowSeen, now: number): string | (Node | string)[] {
  // what was paid, from the invoice; the record's amount is the order's worth, lower after a move to a cheaper name
  const paid = invoice ? `${dollars(invoice.amount, true)} ${methodName(invoice.cryptoCurrency ?? "card")}` : recordedPaid(o)
  if (lapsed({ view, answer }, now)) return `Expired ${view.expiresAt ? dateOf(view.expiresAt, true) : ""}`.trim()
  if (view.phase === "registered") {
    const shown = answer?.status === "registered" ? answer.entities[0]?.displayName : undefined
    // a short display name stays on one line
    const target = shown && shown.length <= NAME_KEPT_WHOLE ? shown.replaceAll(" ", "\u00a0") : shown
    return [view.expiresAt ? `Until ${dateOf(view.expiresAt, true)}` : null, target ? `points at ${target}` : null, continued(paid)].filter(Boolean).join(SEP)
  }
  if (invoice?.status === "paid" && view.phase === "unpaid") return ["Paid after the invoice closed; support refunds it", ...reference(invoice.invoiceId)]
  if (invoice?.status === "expired" && view.phase === "unpaid") {
    const part = Number(invoice.cryptoAmountPaid ?? "0") > 0 && !invoice.paidInFull
    const arrived = part ? "Part of the payment arrived" : api.holdsPayment(invoice) ? "A payment did not complete before the invoice closed" : null
    return arrived ? [`${arrived}; support sorts it out`, ...reference(invoice.invoiceId)] : `Nothing was charged${SEP}${dateOf(Date.parse(o.createdAt) / 1000, true)}`
  }
  if (view.phase === "taken" && o.method === "code") return "Paid with a code, released for another name"
  if (waitsToSign(view, now)) return `${o.ownerCode ? "Open the order so this browser can sign it" : "Waiting for SimpleX to sign it"}${SEP}${continued(paid)}`
  return PROGRESS[view.phase] ? `${PROGRESS[view.phase]}${SEP}${continued(paid)}` : paid
}

function orderRow(stored: store.OrderRecord, s: ListState): HTMLElement {
  const id = stored.registrationId
  const o = s.orders.find((r) => r.registrationId === id) ?? stored
  const seen = s.seen[id]
  // the order may have moved to another name since it was stored
  const label = seen?.view.label ?? o.label
  const title = `${label}.${seen?.view.tld ?? o.tld}`
  const showCodeLink = () => small("Show code", `${id}-code`, () => showCode(o), "key")
  const acts = seen?.view.phase !== "registered" || o.ownerCode === null || seen.answer === undefined ? [small("Open", `${id}-open`, () => go(store.orderUrl(o)))]
    : !lapsed(seen, s.now) && (seen.answer === null || editable(seen.answer, o.owner)) ? [showCodeLink(), small("Edit links", `${id}-edit`, () => go(`/#/edit/${id}`), "link")]
      : [showCodeLink()]
  return row(id, markOf(label), title, el("span", {}, seen ? subLine(o, seen, s.now) : recordedPaid(o)), el("span", {}, rowChip(s, o, seen)), el("span", { class: "acts-inner" }, ...acts))
}

function rowChip(s: ListState, o: store.OrderRecord, seen: RowSeen | undefined): HTMLElement {
  if (s.unread.includes(o.registrationId)) return chip("Not checked", "warn")
  if (!seen) return chip("Checking", "", true)
  const [text, tone] = lapsed(seen, s.now) ? ["Expired", "bad"] : phaseChip(seen.view, seen.invoice, o, s.now)
  return chip(text, tone, tone !== "bad")
}

function pendingRow(p: store.PendingCode, s: ListState, signal: AbortSignal): HTMLElement {
  const key = pendingKey(p)
  const finding = s.finding[p.ownerCode]
  const hold = finding === "none" ? null : s.hold
  const find = finding === "none" ? null : small("Find the order", `${key}-find`, () => void findOrder(p), "refresh")
  if (find && (finding === "finding" || s.hold)) find.setAttribute("aria-disabled", "true")
  const state = el("span", {}, hold ? chip("", "warn")
    : finding === "none" ? chip("No order was made", "bad")
      : finding === "unchecked" ? chip("Not checked", "bad") : chip("Checkout not finished", "warn"))
  if (hold) waitOut(state.firstElementChild as HTMLElement, secondsLeft(hold), (left) => `Try again in ${left}`, () => undefined, signal)
  return row(key, markOf(p.label), `${p.label}.${p.tld}`, `Name code shown ${dateOf(Date.parse(p.createdAt) / 1000, true)}`, state,
    find, small("Remove", `${key}-remove`, () => removePending(p)))
}

function codeRow(c: store.CodeRecord, s: ListState): HTMLElement {
  const check = s.checked[c.code]
  const copy = copyButton(c.code, "Copy", "small-btn")
  copy.dataset.focus = `${c.code}-copy`
  const [text, tone] = check === undefined ? ["Checking", ""] : check === "unchecked" ? ["Not checked", "warn"] : CODE_CHIPS[check]
  const node = row(c.code, "≡", c.code, `Names of ${c.minLength} or more letters, for ${c.years} years${SEP}added ${dateOf(Date.parse(c.addedAt) / 1000, true)}`,
    el("span", {}, chip(text, tone, check === undefined || check === "unused")), copy)
  node.classList.add("code-row")
  return node
}

function showCode(o: store.OrderRecord): void {
  const code = o.ownerCode!
  popup(el("div", { class: "popup", role: "dialog", "aria-label": "Name code" },
    el("div", { class: "modal-head" }, el("h3", {}, nameText(o.label, o.tld)),
      el("a", { class: "icon-btn", href: "#", role: "button", "aria-label": "Close", onclick: (e: Event) => { e.preventDefault(); closePopup() } }, icon("x"))),
    el("p", { class: "sec-note" }, "The name code owns the name. Scan or enter it in SimpleX to move the name to the app."),
    codeDisplay(code),
    el("div", { class: "center mt-16" }, el("div", { class: "qr" }, qrSvg(code, "name code")))))
}

let restore: RestoreState = initialRestore(null)
let restoreShown = false
let restoreRoute = -1
let restoreField: HTMLInputElement | null = null
const RESTORE = "restore"

export function restorePage(): void {
  const fresh = !isRedraw() || !restoreShown
  if (fresh) {
    restore = initialRestore(tabHold())
    restoreShown = false
  }
  restoreRoute = currentRoute()
  dispatchRestore({ type: "opened" })
  if (fresh) restoreField?.focus()
}

function dispatchRestore(event: RestoreEvent): void {
  restore = reduceRestore(restore, event)
  if (!isRoute(restoreRoute)) return
  restoreShown = true
  draw(RESTORE, (signal) => buildRestore(restore, signal))
}

function restoreBox(): HTMLElement {
  const input = el("input", { type: "text", "aria-label": "Name code", spellcheck: "false", placeholder: "SN-…", autocomplete: "off" })
  restoreField = input
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !restoreOff(restore)) void runRestore() })
  input.addEventListener("input", () => dispatchRestore({ type: "edited" }))
  return el("div", { class: "input code-input mt-8" }, icon("key"), input)
}

async function runRestore(): Promise<void> {
  const text = restoreField!.value
  // focus on Restore, which a refusal of the code itself keeps off, goes back to the code
  const pressed = document.activeElement instanceof HTMLElement && document.activeElement.dataset.focus === RESTORE
  const refuse = (why: Extract<RestoreEvent, { type: "refused" }>["why"]) => {
    dispatchRestore({ type: "refused", why })
    if (pressed && !REFUSALS[why].again) restoreField?.focus({ preventScroll: true })
  }
  const code = parseNameCode(text)
  if (code === null) return refuse("invalid")
  if (code.kind === "prepaid") return refuse("prepaid")
  dispatchRestore({ type: "find-started" })
  try {
    const { record } = await flow.restore(text)
    if (isRoute(restoreRoute)) go(store.orderUrl(record))
  } catch (e) {
    if (!isRoute(restoreRoute)) return
    if (e instanceof api.ApiError && e.code === "not_found") return refuse("none")
    // the service asks for a wait before the next lookup; the button stays off until then, whatever is typed meanwhile
    if (holdFrom(e)) return dispatchRestore({ type: "held", until: holdEnd(), lead: "Your code is fine. " })
    refuse(e instanceof api.ApiError ? "unasked" : "other")
  }
}

// a refusal of the code itself holds Restore until the code is edited; one of the service can be tried again
const restoreOff = ({ busy, hold, refusal }: RestoreState) => busy || hold !== null || (refusal !== null && !REFUSALS[refusal].again)

function buildRestore(s: RestoreState, signal: AbortSignal): HTMLElement {
  const box = kept("restore-code", restoreBox)
  const refusal = s.refusal && REFUSALS[s.refusal]
  box.className = `input code-input mt-8${refusal ? " bad" : ""}`
  const action = setAction(btn("Restore", "block", () => void runRestore(), icon("arrow")), s.busy, restoreOff(s))
  action.dataset.focus = RESTORE
  holdEnder(signal, () => dispatchRestore({ type: "hold-ended" }))(s.hold !== null)
  const note = s.busy ? el("p", { class: "hint" }, "Finding the code's orders…")
    : s.hold ? holdNotice(s.hold, signal)
      : refusal ? el("div", { class: "mt-14" }, refusal.verdict ? el("p", { class: "verdict bad" }, `${refusal.title}. ${refusal.text}`) : alertBox("danger", "alert", refusal.title, refusal.text))
        : null
  return screen({ title: "Restore with a name code", lead: "The code stays in this browser. The service sees only a signature from the name's key." },
    el("div", { class: "panel" }, el("div", { class: "panel-sec" },
      el("span", { class: "label" }, "Name code"), box, keptLive("restore-note", undefined, note), el("div", { class: "mt-20" }, action))),
    el("aside", { class: "panel summary" },
      el("span", { class: "label" }, "How it works"),
      el("div", { class: "why" },
        el("div", {}, icon("wallet"), "The page rebuilds the name's key and the order's secret from the code."),
        el("div", {}, icon("shield"), "It signs a request with that key and finds the code's orders; knowing the address alone finds nothing."),
        el("div", {}, icon("refresh"), "If the registration waits for this browser, it carries on from here."))))
}

let edit: EditState = initialEdit("", null)
let editShown = false
let editOpened = 0
let editRoute = -1

export function editPage(registrationId: string): void {
  const redraw = isRedraw() && editShown && edit.registrationId === registrationId
  if (!redraw) {
    editOpened += 1
    editShown = false
    edit = initialEdit(registrationId, store.orderByRegistration(registrationId) ?? null)
  }
  editRoute = currentRoute()
  if (screenOfEdit(edit) === "edit-no-code") return dispatchEdit({ type: "opened" })
  if (redraw) return readAgain()
  drawLoading("Reading the name…")
  void readEdit(editOpened)
}

function dispatchEdit(event: EditEvent): void {
  edit = reduceEdit(edit, event)
  if (!isRoute(editRoute)) return
  const kind = screenOfEdit(edit)
  editShown = true
  draw(kind, (signal) => EDIT_BUILDERS[kind](edit, signal))
}

const editOpen = (gen: number) => gen === editOpened && isRoute(editRoute)

function answerEdit(gen: number, event: EditEvent): void {
  if (editOpen(gen)) dispatchEdit(event)
}

async function readEdit(gen: number): Promise<void> {
  const stored = edit.record!
  let view: api.RegistrationView
  let answer: api.SearchAnswer
  let record = stored
  try {
    view = stored.invoiceId ? (await api.readInvoice(stored.invoiceId)).registration : await api.readRegistration(stored.registrationId)
    record = await flow.syncRecord(stored, view) ?? stored
    answer = await api.searchName(record.request.labelHash, record.label.length)
  } catch (e) {
    // a forgotten unpaid order may have a newer one, found with the code
    const newer = e instanceof api.ApiError && e.code === "not_found" ? await flow.newerOrder(stored).catch(() => null) : null
    if (!editOpen(gen)) return
    if (newer) return redirect(`/#/edit/${newer.registrationId}`)
    return dispatchEdit({ type: "read-failed" })
  }
  if (!editOpen(gen)) return
  if (view.phase === "unpaid") {
    // the name may have been registered through a newer invoice that another browser made, perhaps under another name
    const newer = await flow.newerOrder(record).catch(() => null)
    if (!editOpen(gen)) return
    if (newer) return redirect(`/#/edit/${newer.registrationId}`)
  }
  dispatchEdit({ type: "answered", view, answer, record, now: api.serviceNow(), hold: tabHold() })
}

function readAgain(): void {
  if (edit.reading) return
  dispatchEdit({ type: "read-started" })
  void readEdit(editOpened)
}

const editTitle = ({ record }: EditState): Kid => ["Edit links for ", gradName(record!.label, record!.tld)]

const editNotice = (title: Kid, ...content: Kid[]): HTMLElement => screen({ title }, el("div", { class: "narrow" }, ...content))

const notice = (ic: IconName, title: string, text: string): Builder<EditState> => (s) => editNotice(editTitle(s), alertBox("info", ic, title, text))

// The chain takes an expired name's link edits from its holder until someone registers it again; this page sends none.
function expiredText({ view, answer, now }: EditRead): string {
  return `${ranOut(view.expiresAt)} Names are not renewed, so this page no longer edits its links. ${againLine(view.expiresAt, answer, now)}`
}

function buildExpired(s: EditState): HTMLElement {
  return editNotice(editTitle(s), alertBox("info", "clock", "This name has expired", expiredText(s.read!)))
}

function buildUnreadable(s: EditState, signal: AbortSignal): HTMLElement {
  if (!s.reading) after(EDIT_RETRY_MS, readAgain, signal)
  return editNotice(editTitle(s), alertBox("warn", "alert", "The name could not be read now", "This page tries again by itself."),
    el("div", { class: "mt-14" }, setAction(btn("Try again", "quiet", readAgain, icon("refresh")), s.reading, false)))
}

function resultNode(f: EditForm, signal: AbortSignal): HTMLElement | null {
  const box = (node: HTMLElement) => el("div", { class: "mt-14" }, node)
  if (f.hold) return holdNotice(f.hold, signal)
  switch (f.result) {
    case null: return null
    case "sending": return el("p", { class: "hint" }, "Signing and sending…")
    case "nothing": return box(alertBox("info", "info", null, "Nothing has changed."))
    case "saved": return box(alertBox("ok", "check", "Links saved", "The change is on chain; the app shows it within a few minutes."))
    case "unanswered": return box(alertBox("warn", "clock", "No answer yet", "The change may still go through. Reload this page in a few minutes to see whether it did before saving again."))
    case "moved": return box(alertBox("warn", "clock", f.sent.length ? notSaved(f) : "An earlier save got there first",
      f.sent.length ? `Another save reached the chain first. The ${LINK_NAMES[unsent(f.changes, f.sent)!]} is still as you typed it: save again to send it.` : "It was still on its way when this one was signed. The fields now show the links on chain: change them and save again."))
    case "refused": return box(alertBox("danger", "alert", notSaved(f), "Try again in a moment."))
  }
}

// a field checks the link it opens with as it is made, which is no change to send
function editField(kind: keyof api.Links, placeholder: string, label: string, value: string): HTMLElement {
  let made = false
  const field = linkField(kind, placeholder, label, value, (link) => { if (made) dispatchEdit({ type: "field-changed", kind, value: link }) })
  made = true
  return field
}

async function saveLinks(fields: HTMLElement[]): Promise<void> {
  const pending = fields.find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
  if (pending) return pending.querySelector("input")!.focus()
  const gen = editOpened
  dispatchEdit({ type: "save-started" })
  const { record, read, form } = edit
  if (!form?.saving) return
  try {
    await flow.saveLinks(record!, read!.view, form.nonce, form.changes, (kind) => {
      store.updateOrder(record!.registrationId, { linksSavedAt: new Date().toISOString() })
      answerEdit(gen, { type: "link-saved", kind })
    })
    answerEdit(gen, { type: "save-done" })
  } catch (e) {
    // no answer is not a refusal: the edit may still be mined, and sending it again would pay for it twice
    if (e instanceof api.ApiError && (e.code === "network" || e.code === "edit_pending")) return answerEdit(gen, { type: "save-unanswered" })
    // Save stays off for the wait the service asked for, whatever the fields do meanwhile
    if (holdFrom(e)) return answerEdit(gen, { type: "save-held", until: holdEnd() })
    // A refused edit may mean the nonce moved: an earlier save, from a page reloaded before it was mined, or from
    // another browser. The next save signs with the fresh one, and the page says why this one did not go.
    const fresh = await api.searchName(record!.request.labelHash, record!.label.length).catch(() => null)
    if (!editOpen(gen)) return
    const now = edit.form!
    const nonce = fresh?.status === "registered" && fresh.recordsNonce != null && fresh.recordsNonce > now.nonce ? fresh.recordsNonce : null
    const records = nonce !== null && fresh?.status === "registered" && fresh.records ? fresh.records : null
    if (records) showChain(records, now, fields)
    dispatchEdit({ type: "save-refused", moved: nonce === null ? null : { nonce, records } })
  }
}

function showChain(records: api.Links, f: EditForm, fields: HTMLElement[]): void {
  ;(["contact", "channel"] as const).forEach((kind, i) => {
    const input = fields[i].querySelector("input")!
    if ((f.sent.length && kind in f.changes && !f.sent.includes(kind)) || input.value === records[kind]) return
    fields[i].dataset.kept = records[kind]
    input.value = records[kind]
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function buildEditForm(s: EditState, signal: AbortSignal): HTMLElement {
  const f = s.form!
  const fields = [
    kept("edit-contact", () => editField("contact", "Paste your address", "Address", f.current.contact)),
    kept("edit-channel", () => editField("channel", "Paste your channel", "Channel", f.current.channel)),
  ]
  const save = setAction(btn("Save links", "block", () => void saveLinks(fields)), f.saving, f.hold !== null || f.unanswered || f.settled)
  save.dataset.focus = "save"
  const answer = resultNode(f, signal)
  // Save, turned off by its answer, hands focus to the answer, which shares its key
  if (answer?.firstElementChild instanceof HTMLElement && ((f.result === "saved" && f.settled) || f.result === "unanswered")) {
    answer.firstElementChild.tabIndex = -1
    answer.firstElementChild.dataset.focus = "save"
  }
  holdEnder(signal, () => dispatchEdit({ type: "hold-ended" }))(f.hold !== null)
  return screen({ title: editTitle(s) },
    el("div", { class: "panel" }, el("div", { class: "panel-sec" },
      el("span", { class: "label" }, "Contact address"), fields[0], el("span", { class: "label block mt-20" }, "Channel"), fields[1])),
    el("aside", { class: "panel summary" },
      el("span", { class: "label" }, "Saving"),
      el("div", { class: "why" },
        el("div", {}, icon("key"), "This browser signs the change with the name's key, from your name code."),
        el("div", {}, icon("shield"), "SimpleX sends it and pays the fee.")),
      el("div", { class: "mt-20" }, save), keptLive("edit-answer", undefined, answer)))
}

const EDIT_BUILDERS: Record<EditKind, Builder<EditState>> = {
  "edit-no-code": () => editNotice("Edit links", alertBox("info", "key", "The name code is not in this browser", "Restore it in Your names to edit this name's links.")),
  "edit-unreadable": buildUnreadable,
  "edit-expired": buildExpired,
  "edit-in-app": notice("phone", "This name is managed in SimpleX", "It was moved to the app's wallet, so its links are edited in the app."),
  "edit-elsewhere": notice("link", "This name's links are kept elsewhere", "It points at another resolver, so its links are not edited here."),
  "edit-not-registered": notice("clock", "The name is not registered yet", "Its links can be edited once the registration is final."),
  edit: buildEditForm,
}

export function trademarksPage(): void {
  draw("trademarks", () => screen({ title: "Trademark owners", lead: "Some names are reserved and cannot be bought." },
    el("div", { class: "panel narrow" }, el("div", { class: "panel-sec" },
      el("p", {}, "If you own a trademark and want the matching name reserved for you, write to ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL),
        " with the name and proof that you own the mark. A reserved name can only be registered by the SimpleX team for its owner.")))))
}
