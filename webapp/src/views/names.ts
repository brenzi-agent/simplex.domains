// Your names: this browser's orders and codes, restoring an order with its name code, and editing a name's links.
import * as api from "../api.ts"
import { parseNameCode } from "../crypto/code.ts"
import { alertBox, btn, chip, codeDisplay, copyButton, el, gradName, icon, liveRegion, nameText, waitOut } from "../dom.ts"
import * as focus from "../focus.ts"
import * as flow from "../flow.ts"
import { addTo, live, moving, removeFrom, syncList, textSpan } from "../motion.ts"
import { dateOf, dollars, methodName, SEP } from "../format.ts"
import { qrSvg } from "../qr.ts"
import { headingFocus, step } from "../screens/machine.ts"
import {
  CODE_CHIPS, EDIT_RETRY_MS, editable, editMachine, type EditEvent, type EditForm, type EditKind, type EditState, hasRecords, initialEdit, initialList,
  againLine, initialRestore, lapsed, LINK_NAMES, ranOut, type EditRead, moneyReached, listedOrders, listMachine, type ListEvent, type ListKind, type ListState, notSaved, phaseChip, REFUSALS,
  restoreMachine, type RestoreEvent, type RestoreKind, type RestoreState, type RowSeen, type CodeCheck, screenOfEdit, settled, type Stored, unsent, waitsToSign,
} from "../screens/names.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { linkField } from "./checkout.ts"
import { codePopup, useCode, verdictNode } from "./codes.ts"
import { type Build, type Built, closePopup, CONTACT_EMAIL, currentRoute, go, isRedraw, isRoute, page, pageHead, placeholderSoon, popup, redirect, screens, twoCols, whenLeaving } from "./shell.ts"
import { after, oneAtATime } from "./effects.ts"
import { holdEnd, holdEnder, holdFrom, holding, tabHold } from "./hold.ts"
import { changeTo, drawAs, holdNotice, secondsLeft, setAction, unchanging } from "./slots.ts"

// past this many rows the rest come in with the last, so a long list does not keep the reader waiting
const MOST_STAGGERED = 8
const FOLLOW_MS = 15_000
const UNREAD_RETRY_MS = 5_000

function row(mark: string, title: string, sub: Node | string, state: Node, ...acts: Node[]): HTMLElement {
  return el("div", { class: "row-item" },
    el("span", { class: "mark" }, live(el("span", {}, textSpan(mark)))), el("div", { class: "main" }, live(el("b", { title }, textSpan(title))), el("div", { class: "sub" }, sub)), state, live(el("div", { class: "acts" }, ...acts)))
}

const small = (text: string, onclick: () => void, ic?: Parameters<typeof icon>[0]) =>
  el("a", { class: "small-btn", href: "#", role: "button", onclick: (e: Event) => { e.preventDefault(); onclick() } }, ic ? icon(ic) : null, text)

let list: ListState = initialList({ orders: [], pending: [], codes: [], canPersist: true }, null, {}, {}, 0)
let listShown: ListKind | null = null
const showList = screens<ListState>()
let listOpened = 0
let listRoute = -1
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
  if (!isRedraw() || listShown === null) {
    listOpened += 1
    listShown = null
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
  const result = step(listMachine, list, listShown, event)
  list = result.state
  lastSeen = list.seen
  lastChecked = list.checked
  if (!isRoute(listRoute)) return
  listShown = result.screen
  showList("names", result.screen, list, buildNames, null, result.motion)
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
  session.setAppliedCode(null)
  dispatchList({ type: "forget-confirmed" })
}

interface ListRow { node: HTMLElement; show: (s: ListState) => void }

const pendingKey = (p: store.PendingCode) => `${p.label}@${p.createdAt}`
const EMPTY_KEY = "empty"
const leadOf = (canPersist: boolean) => canPersist ? "This list is kept only in this browser." : "This browser cannot keep this list: it empties when the page reloads."

function buildNames(s: ListState, signal: AbortSignal): Built<ListState> {
  listStop = signal
  const head = pageHead("Your names", leadOf(s.canPersist))
  const lead = live(head.querySelector<HTMLElement>(".lead")!)
  // The rows are a part of their own so the part's clip while its height eases never cuts the panel's shadow.
  const orderPart = live(el("div", {}))
  const codePart = live(el("div", {}))
  const forget = live(el("div", {}))
  const forgetLink = el("a", { class: "danger-link", href: "#", role: "button", onclick: (e: Event) => {
    e.preventDefault()
    dispatchList({ type: "forget-asked" })
    keep.focus({ preventScroll: true })
  } }, "Forget everything in this browser")
  const keep = btn("Keep them", "quiet", () => {
    dispatchList({ type: "forget-kept" })
    forgetLink.focus({ preventScroll: true })
  })
  const question = el("div", { class: "mt-18" }, alertBox("bad", "alert", "Forget every name and code in this browser?",
    "Everything listed here is removed from this browser. Without your saved copies, the name codes and codes cannot be restored."),
  el("div", { class: "actions mt-14" }, btn("Forget everything", "danger", forgetEverything), keep))
  const rows = new Map<string, ListRow>()
  const rowFor = (key: string, build: () => ListRow) => {
    const known = rows.get(key)
    if (known) return known
    const made = build()
    rows.set(key, made)
    return made
  }
  const emptyNote = (part: HTMLElement, text: string): HTMLElement =>
    [...part.children].find((n): n is HTMLElement => n instanceof HTMLElement && n.dataset.key === EMPTY_KEY && !n.classList.contains("outgoing"))
    ?? el("p", { class: "sec-note empty-list", "data-key": EMPTY_KEY }, text)
  const watchHold = holdEnder(signal, () => dispatchList({ type: "hold-ended" }))
  const update = (next: ListState) => {
    changeTo(lead, leadOf(next.canPersist))
    const fresh = new Set<string>()
    const make = (key: string, build: () => ListRow) => rowFor(key, () => {
      fresh.add(key)
      return build()
    })
    const orderRows = [...next.pending.map((p) => make(pendingKey(p), () => pendingRow(p))), ...listedOrders(next).map((o) => make(o.registrationId, () => orderRow(o)))]
    const codeRows = next.codes.map((c) => make(c.code, () => codeRow(c)))
    for (const r of [...orderRows, ...codeRows]) r.show(next)
    const wanted = new Set([...orderRows, ...codeRows].map((r) => r.node))
    const leaving = [...rows].filter(([, r]) => !wanted.has(r.node))
    if (leaving.some(([, r]) => r.node.contains(document.activeElement))) focus.focusHeading()
    const byUrl = new Map(next.orders.map((o) => [store.orderUrl(o), o]))
    for (const [key, r] of leaving) {
      rows.delete(key)
      const replacedBy = next.orders.find((o) => o.registrationId === key)?.replacedBy
      const successor = replacedBy ? byUrl.get(replacedBy) : undefined
      const at = successor ? orderRows.findIndex((n) => n.node.dataset.key === successor.registrationId) : -1
      if (!successor || at < 0) continue
      if (!fresh.has(successor.registrationId)) {
        removeFrom(orderPart, orderRows[at].node)
        orderRows[at] = orderRow(successor)
        orderRows[at].show(next)
        rows.set(successor.registrationId, orderRows[at])
      }
      removeFrom(orderPart, r.node, orderRows[at].node)
    }
    syncList(orderPart, orderRows.length ? orderRows.map((r) => r.node) : [emptyNote(orderPart, "No names in this browser yet.")])
    syncList(codePart, codeRows.length ? codeRows.map((r) => r.node) : [emptyNote(codePart, "No codes in this browser yet.")])
    if (!hasRecords(next) && forget.contains(document.activeElement)) focus.focusHeading()
    drawAs(forget, hasRecords(next) ? next.asking ? "asking" : "link" : "", () => hasRecords(next) ? [next.asking ? question : forgetLink] : [])
    watchHold(next.hold !== null)
  }
  update(s)
  ;[...orderPart.children, ...codePart.children].filter((n): n is HTMLElement => n.classList.contains("row-item")).forEach((r, i) => {
    r.classList.add("entering")
    r.style.setProperty("--i", String(Math.min(i, MOST_STAGGERED)))
    // animationend bubbles up from what the row holds, so only the row's own rise counts
    const risen = (e: AnimationEvent) => {
      if (e.target !== r) return
      r.classList.remove("entering")
      r.style.removeProperty("--i")
      r.removeEventListener("animationend", risen)
    }
    r.addEventListener("animationend", risen)
  })
  return { sections: [head,
    el("div", { class: "wrap" },
      el("div", { class: "toolbar" }, btn([icon("key"), "Add a code"], "quiet", () => codePopup("add")), btn([icon("refresh"), "Restore with a name code"], "quiet", () => go("/#/restore"))),
      el("div", { class: "panel" }, el("div", { class: "list-title" }, el("h2", {}, "Names")), orderPart),
      el("div", { class: "panel mt-16" }, el("div", { class: "list-title" }, el("h2", {}, "Codes")), codePart),
      forget)], update }
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

function orderRow(stored: store.OrderRecord): ListRow {
  const id = stored.registrationId
  let o = stored
  const sub = live(el("span", {}))
  const state = live(el("span", {}))
  const open = small("Open", () => go(store.orderUrl(o)))
  const showCodeLink = small("Show code", () => showCode(o), "key")
  const editLink = small("Edit links", () => go(`/#/edit/${id}`), "link")
  const acts = live(el("span", { class: "acts-inner" }))
  const node = row(markOf(o.label), `${o.label}.${o.tld}`, sub, state, acts)
  node.dataset.key = id
  const title = node.querySelector<HTMLElement>(".main b")!
  const mark = node.querySelector<HTMLElement>(".mark > span")!
  const chipOf = (s: ListState, seen: RowSeen | undefined): [string, string, boolean] => {
    if (s.unread.includes(id)) return ["Not checked", "warn", false]
    if (!seen) return ["Checking", "", true]
    const [text, tone] = lapsed(seen, s.now) ? ["Expired", "bad"] : phaseChip(seen.view, seen.invoice, o, s.now)
    return [text, tone, tone !== "bad"]
  }
  const show = (s: ListState) => {
    o = s.orders.find((r) => r.registrationId === id) ?? o
    const seen = s.seen[id]
    // the order may have moved to another name since it was stored
    const label = seen?.view.label ?? o.label
    const shown = `${label}.${seen?.view.tld ?? o.tld}`
    changeTo(title, shown)
    title.title = shown
    changeTo(mark, markOf(label))
    changeTo(sub, ...[seen ? subLine(o, seen, s.now) : recordedPaid(o)].flat())
    changeTo(state, chip(...chipOf(s, seen)))
    if (seen?.view.phase !== "registered" || o.ownerCode === null || seen.answer === undefined) return void drawAs(acts, "open", () => [open])
    const editing = !lapsed(seen, s.now) && (seen.answer === null || editable(seen.answer, o.owner))
    drawAs(acts, editing ? "edit" : "code", () => editing ? [showCodeLink, editLink] : [showCodeLink])
  }
  return { node, show }
}

function pendingRow(p: store.PendingCode): ListRow {
  const state = live(el("span", {}))
  const node = row(markOf(p.label), `${p.label}.${p.tld}`, `Name code shown ${dateOf(Date.parse(p.createdAt) / 1000, true)}`, state)
  node.dataset.key = pendingKey(p)
  const acts = node.querySelector<HTMLElement>(".acts")!
  const find = small("Find the order", () => void findOrder(p), "refresh")
  const remove = small("Remove", () => removePending(p))
  // focus moving on from a control that went never lands here
  remove.dataset.destructive = ""
  acts.append(find, remove)
  let drawn = ""
  const show = (s: ListState) => {
    const finding = s.finding[p.ownerCode]
    if (finding === "none" && find.parentNode === acts && !find.classList.contains("outgoing")) {
      const focused = document.activeElement === find
      removeFrom(acts, find)
      if (focused) focus.focusHeading()
    }
    if (finding === "finding" || s.hold) find.setAttribute("aria-disabled", "true")
    else find.removeAttribute("aria-disabled")
    const hold = finding === "none" ? null : s.hold
    const shown = finding === "none" ? "none" : hold ? `held ${hold.until}` : finding === "unchecked" ? "unchecked" : "idle"
    if (shown === drawn) return
    drawn = shown
    if (!hold) return state.replaceChildren(shown === "idle" ? chip("Checkout not finished", "warn") : chip(shown === "none" ? "No order was made" : "Not checked", "bad"))
    const waiting = chip("", "warn")
    state.replaceChildren(waiting)
    waitOut(waiting, secondsLeft(hold), (left) => `Try again in ${left}`, () => undefined)
  }
  return { node, show }
}

function codeRow(c: store.CodeRecord): ListRow {
  const state = live(el("span", {}))
  const copy = copyButton(c.code, "Copy", "small-btn")
  const useButton = () => small("Use", () => useCode(c))
  let use = useButton()
  const node = row("≡", c.code, `Names of ${c.minLength} or more letters, for ${c.years} years${SEP}added ${dateOf(Date.parse(c.addedAt) / 1000, true)}`, state, use, copy)
  node.classList.add("code-row")
  node.dataset.key = c.code
  const acts = node.querySelector<HTMLElement>(".acts")!
  const show = (s: ListState) => {
    const check = s.checked[c.code]
    if (check === undefined) return changeTo(state, chip("Checking", "", true))
    if (check === "unchecked") return changeTo(state, chip("Not checked", "warn"))
    const [text, tone] = CODE_CHIPS[check]
    changeTo(state, chip(text, tone, check === "unused"))
    const usable = use.parentNode === acts && !use.classList.contains("outgoing")
    if (check !== "unused" && usable) removeFrom(acts, use)
    if (check === "unused" && !usable) {
      use = useButton()
      addTo(acts, use, copy)
    }
  }
  return { node, show }
}

function showCode(o: store.OrderRecord): void {
  const code = o.ownerCode!
  popup(el("div", { class: "modal", role: "dialog", "aria-label": "Name code" },
    el("div", { class: "modal-head" }, el("h3", {}, nameText(o.label, o.tld)),
      el("a", { class: "icon-btn", href: "#", role: "button", "aria-label": "Close", onclick: (e: Event) => { e.preventDefault(); closePopup() } }, icon("x"))),
    el("p", { class: "sec-note" }, "The name code owns the name. Scan or enter it in SimpleX to move the name to the app."),
    codeDisplay(code),
    el("div", { class: "center mt-16" }, el("div", { class: "qr" }, qrSvg(code, "name code")))))
}

// Focus dropped by a button that stays off goes to the answer below it; the heading would scroll the answer away on a phone.
function focusAnswer(answer: HTMLElement): void {
  if (document.activeElement !== document.body) return
  answer.tabIndex = -1
  answer.focus({ preventScroll: true })
  answer.scrollIntoView({ block: "nearest", behavior: moving() ? "smooth" : "auto" })
}

let restore: RestoreState = initialRestore(null)
let restoreShown: RestoreKind | null = null
const showRestore = screens<RestoreState>()
let restoreRoute = -1
let restoreField: HTMLInputElement | null = null

export function restorePage(): void {
  const fresh = !isRedraw() || restoreShown === null
  if (fresh) {
    restore = initialRestore(tabHold())
    restoreShown = null
  }
  restoreRoute = currentRoute()
  dispatchRestore({ type: "opened" })
  if (fresh) restoreField?.focus()
}

function dispatchRestore(event: RestoreEvent): void {
  const result = step(restoreMachine, restore, restoreShown, event)
  restore = result.state
  if (!isRoute(restoreRoute)) return
  restoreShown = result.screen
  showRestore("names", result.screen, restore, buildRestore, null, result.motion)
}

function buildRestore(s: RestoreState, signal: AbortSignal): Built<RestoreState> {
  const input = el("input", { type: "text", "aria-label": "Name code", spellcheck: "false", placeholder: "SN-…", autocomplete: "off" })
  restoreField = input
  const box = el("div", { class: "input code-input mt-8" }, icon("key"), input)
  const note = liveRegion()
  const action = btn("Restore", "lg block", () => void run(), icon("arrow"))
  // Restore had focus when the lookup started, and lost it to the page when it was turned off
  let pressed = false
  const run = async () => {
    const code = parseNameCode(input.value)
    if (code === null) return dispatchRestore({ type: "refused", why: "invalid" })
    if (code.kind === "prepaid") return dispatchRestore({ type: "refused", why: "prepaid" })
    pressed = document.activeElement === action
    dispatchRestore({ type: "find-started" })
    try {
      const { record } = await flow.restore(input.value)
      if (!signal.aborted) go(store.orderUrl(record))
    } catch (e) {
      if (signal.aborted) return
      if (e instanceof api.ApiError && e.code === "not_found") return dispatchRestore({ type: "refused", why: "none" })
      // the service asks for a wait before the next lookup; the button stays off until then, whatever is typed meanwhile
      if (holdFrom(e)) return dispatchRestore({ type: "held", until: holdEnd(), lead: "Your code is fine. " })
      dispatchRestore({ type: "refused", why: e instanceof api.ApiError ? "unasked" : "other" })
    }
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") action.click() })
  input.addEventListener("input", () => dispatchRestore({ type: "edited" }))
  const watchHold = holdEnder(signal, () => dispatchRestore({ type: "hold-ended" }))
  const update = (next: RestoreState) => {
    const refusal = next.refusal && REFUSALS[next.refusal]
    box.className = `input code-input mt-8${refusal ? " bad" : ""}`
    const refocus = refusal !== null && !refusal.again && (document.activeElement === action || (pressed && document.activeElement === document.body))
    setAction(action, next.busy, next.hold !== null || (refusal !== null && !refusal.again))
    if (refocus) input.focus({ preventScroll: true })
    drawAs(note, JSON.stringify([next.busy, next.hold, next.refusal]), () => next.busy ? [el("p", { class: "hint" }, "Finding the code's orders…")]
      : next.hold ? [holdNotice(next.hold)]
        : refusal ? [el("div", { class: "mt-14" }, refusal.verdict ? verdictNode({ ok: false, title: refusal.title, line: refusal.text }) : alertBox("bad", "alert", refusal.title, refusal.text))]
          : [])
    watchHold(next.hold !== null)
  }
  update(s)
  return { sections: [pageHead("Restore with a name code", "The code stays in this browser. The service sees only a signature from the name's key."),
    twoCols(
      el("div", { class: "panel" }, el("div", { class: "panel-sec" },
        el("span", { class: "label" }, "Name code"), box, note, el("div", { class: "mt-20" }, action))),
      el("aside", { class: "panel summary" },
        el("span", { class: "label" }, "How it works"),
        el("div", { class: "why" },
          el("div", {}, icon("wallet"), "The page rebuilds the name's key and the order's secret from the code."),
          el("div", {}, icon("shield"), "It signs a request with that key and finds the code's orders; knowing the address alone finds nothing."),
          el("div", {}, icon("refresh"), "If the registration waits for this browser, it carries on from here."))))], update }
}

let edit: EditState = initialEdit("", null)
let editShown: EditKind | null = null
const showEdit = screens<EditState>()
let editOpened = 0
let editRoute = -1

export function editPage(registrationId: string): void {
  const redraw = isRedraw() && editShown !== null && edit.registrationId === registrationId
  if (!redraw) {
    editOpened += 1
    editShown = null
    edit = initialEdit(registrationId, store.orderByRegistration(registrationId) ?? null)
  }
  editRoute = currentRoute()
  if (screenOfEdit(edit) === "edit-no-code") return dispatchEdit({ type: "opened" })
  if (redraw) return readAgain()
  placeholderSoon("names")
  void readEdit(editOpened)
}

const dispatchEdit = oneAtATime((event: EditEvent) => {
  const result = step(editMachine, edit, editShown, event)
  edit = result.state
  if (!isRoute(editRoute)) return
  const heading = headingFocus(result, editShown, focus.onPage())
  editShown = result.screen
  showEdit("names", result.screen, edit, EDIT_BUILDS[result.screen], heading, result.motion)
})

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

const editHead = ({ record }: EditState) => pageHead(["Edit links for ", gradName(record!.label, record!.tld)])

const editNotice = (head: HTMLElement, ...content: Node[]): Node[] => [head, el("div", { class: "wrap" }, el("div", { class: "narrow" }, ...content))]

const notice = (ic: Parameters<typeof icon>[0], title: string, text: string): Build<EditState> => (s) => unchanging(editNotice(editHead(s), alertBox("info", ic, title, text)))

// The chain takes an expired name's link edits from its holder until someone registers it again; this page sends none.
function expiredText({ view, answer, now }: EditRead): string {
  return `${ranOut(view.expiresAt)} Names are not renewed, so this page no longer edits its links. ${againLine(view.expiresAt, answer, now)}`
}

function buildExpired(s: EditState): Built<EditState> {
  const text = live(el("span", {}))
  const update = (next: EditState) => changeTo(text, expiredText(next.read!))
  update(s)
  return { sections: editNotice(editHead(s), alertBox("info", "clock", "This name has expired", text)), update }
}

function buildUnreadable(s: EditState, signal: AbortSignal): Built<EditState> {
  const again = btn("Try again", "quiet", readAgain, icon("refresh"))
  let failures = -1
  let stop: (() => void) | null = null
  const update = (next: EditState) => {
    setAction(again, next.reading, false)
    if (next.reading) {
      stop?.()
      stop = null
    }
    if (next.failures === failures) return
    failures = next.failures
    stop?.()
    stop = after(EDIT_RETRY_MS, readAgain, signal)
  }
  update(s)
  return { sections: editNotice(editHead(s), alertBox("warn", "alert", "The name could not be read now", "This page tries again by itself."), el("div", { class: "mt-14" }, again)), update }
}

function resultNode(f: EditForm): HTMLElement | null {
  const box = (node: HTMLElement) => el("div", { class: "mt-14" }, node)
  if (f.hold) return holdNotice(f.hold)
  switch (f.result) {
    case null: return null
    case "sending": return el("p", { class: "hint" }, "Signing and sending…")
    case "nothing": return box(alertBox("info", "info", null, "Nothing has changed."))
    case "saved": return box(alertBox("ok", "check", "Links saved", "The change is on chain; the app shows it within a few minutes."))
    case "unanswered": return box(alertBox("warn", "clock", "No answer yet", "The change may still go through. Reload this page in a few minutes to see whether it did before saving again."))
    case "moved": return box(alertBox("warn", "clock", f.sent.length ? notSaved(f) : "An earlier save got there first",
      f.sent.length ? `Another save reached the chain first. The ${LINK_NAMES[unsent(f.changes, f.sent)!]} is still as you typed it: save again to send it.` : "It was still on its way when this one was signed. The fields now show the links on chain: change them and save again."))
    case "refused": return box(alertBox("bad", "alert", notSaved(f), "Try again in a moment."))
  }
}

function buildEditForm(s: EditState, signal: AbortSignal): Built<EditState> {
  const start = s.form!
  const result = liveRegion()
  const save = btn("Save links", "lg block", () => void submit())
  let built = false
  const changed = (kind: keyof api.Links) => (value: string) => { if (built) dispatchEdit({ type: "field-changed", kind, value }) }
  const fields = el("div", {},
    el("span", { class: "label" }, "Contact address"),
    linkField("contact", "Paste your address", "Address", start.current.contact, changed("contact"), signal),
    el("span", { class: "label block mt-20" }, "Channel"),
    linkField("channel", "Paste your channel", "Channel", start.current.channel, changed("channel"), signal))
  built = true
  const gen = editOpened
  const submit = async () => {
    const pending = [...fields.querySelectorAll<HTMLElement>(".link-field")].find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
    if (pending) return pending.querySelector("input")!.focus()
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
      if (records) showChain(records, now)
      dispatchEdit({ type: "save-refused", moved: nonce === null ? null : { nonce, records } })
    }
  }
  const showChain = (records: api.Links, f: EditForm) => {
    const linkFields = fields.querySelectorAll<HTMLElement>(".link-field")
    ;(["contact", "channel"] as const).forEach((kind, i) => {
      const input = linkFields[i].querySelector("input")!
      if ((f.sent.length && kind in f.changes && !f.sent.includes(kind)) || input.value === records[kind]) return
      linkFields[i].dataset.kept = records[kind]
      input.value = records[kind]
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  const watchHold = holdEnder(signal, () => dispatchEdit({ type: "hold-ended" }))
  const update = (next: EditState) => {
    const f = next.form!
    setAction(save, f.saving, f.hold !== null || f.unanswered || f.settled)
    const key = JSON.stringify([f.hold, f.result, f.result === "moved" || f.result === "refused" ? [f.changes, f.sent] : null])
    const drawn: HTMLElement[] = []
    drawAs(result, key, () => {
      const node = resultNode(f)
      if (node) drawn.push(node)
      return drawn
    })
    const [node] = drawn
    if (node && ((f.result === "saved" && f.settled) || f.result === "unanswered")) focusAnswer(node.firstElementChild as HTMLElement)
    watchHold(f.hold !== null)
  }
  update(s)
  return { sections: [editHead(s),
    twoCols(
      el("div", { class: "panel" }, el("div", { class: "panel-sec" }, fields)),
      el("aside", { class: "panel summary" },
        el("span", { class: "label" }, "Saving"),
        el("div", { class: "why" },
          el("div", {}, icon("key"), "This browser signs the change with the name's key, from your name code."),
          el("div", {}, icon("shield"), "SimpleX sends it and pays the fee.")),
        el("div", { class: "mt-20" }, save), result))], update }
}

const EDIT_BUILDS: Record<EditKind, Build<EditState>> = {
  "edit-no-code": () => unchanging(editNotice(pageHead("Edit links"), alertBox("info", "key", "The name code is not in this browser", "Restore it in Your names to edit this name's links."))),
  "edit-unreadable": buildUnreadable,
  "edit-expired": buildExpired,
  "edit-in-app": notice("phone", "This name is managed in SimpleX", "It was moved to the app's wallet, so its links are edited in the app."),
  "edit-elsewhere": notice("link", "This name's links are kept elsewhere", "It points at another resolver, so its links are not edited here."),
  "edit-not-registered": notice("clock", "The name is not registered yet", "Its links can be edited once the registration is final."),
  edit: buildEditForm,
}

export function trademarksPage(): void {
  page(null, [pageHead("Trademark owners", "Some names are reserved and cannot be bought."),
    el("div", { class: "wrap" }, el("div", { class: "panel narrow" }, el("div", { class: "panel-sec" },
      el("p", {}, "If you own a trademark and want the matching name reserved for you, write to ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL),
        " with the name and proof that you own the mark. A reserved name can only be registered by the SimpleX team for its owner."))))])
}
