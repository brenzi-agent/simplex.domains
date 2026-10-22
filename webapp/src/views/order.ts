// An order's page (?order=<invoice>) or a code registration's (?registration=<id>): payment, registration, and every ending.
import * as api from "../api.ts"
import { parseNameCode } from "../crypto/code.ts"
import { alertBox, announce, btn, codeDisplay, copyButton, el, gradName, icon, type Kid, link, nameText, setAction, type Tone } from "../dom.ts"
import * as flow from "../flow.ts"
import { clock, dateOf, dollars, methodName, SEP, shortAddress } from "../format.ts"
import { paymentUri, qrSvg } from "../qr.ts"
import {
  type ClosedCase, closedCase, coinOf, failedLead, initialState, type Note, type OrderEvent, type OrderKind, type OrderState, reduce, refusalsOf,
  retryRefusal, REVEAL_ATTEMPTS, REVEAL_HOURS, revealDue, revealKey, screenOf, unreadDelay, wakeAt,
} from "../screens/order.ts"
import { checkoutUrl, CODE_FROM_ORDER_URL } from "../screens/routes.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { type MountedCard, mountCard, publishableKey } from "../stripe.ts"
import { seenRegistered } from "./names.ts"
import { holdEnd, holdEnder, holdFrom, holdNotice, tabHold } from "./hold.ts"
import { asStep, type Builder, CONTACT_EMAIL, currentRoute, draw, drawLoading, go, historyPlace, isDark, isRedraw, isRoute, kept, keptLive, outcome, redirect, referenceLine, refresh, screen, searchLink, whenDropped, whenLeaving } from "./shell.ts"

export const RETRY_MS = 3000

// the count stays with its word on one line; a payment taken on first sight waits for no confirmation at all
const confirmations = (n: number) => (n === 1 ? "Waiting for 1\u00a0confirmation" : n > 1 ? `Waiting for ${n}\u00a0confirmations` : "Waiting for the payment to settle")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ORDER_NOTE = "order-note"
const warning = (text: string): Note => ({ tone: "warn", icon: "alert", title: null, text })

let state: OrderState = initialState("", null)
let opened = 0
let pageRoute = -1
let reads = 0
let wakes: ReturnType<typeof setTimeout> | undefined

export function orderPage(invoiceId: string | null, registrationId: string | null): void {
  const mine = currentRoute()
  const reference = invoiceId ?? registrationId!
  const redraw = isRedraw()
  if (!redraw || state.reference !== reference) {
    opened += 1
    // A reveal on its way outlasts the page, so the same order opened again does not sign it twice.
    state = initialState(reference, tabHold(), state.reference === reference ? state.reveal : null)
  }
  pageRoute = mine
  const polls = new AbortController()
  // another tab cancelling or paying this order changes what it is; other orders' changes leave this page, and a card form, alone
  const onStorage = (e: StorageEvent) => {
    const registration = state.view?.id ?? registrationId
    // a card paid in another tab, for an order this browser may have no record of, changes it too
    const ours = (registration && e.key === store.orderKey(registration)) || (invoiceId && e.key === store.cardKey(invoiceId))
    if (ours && isRoute(mine)) refresh()
  }
  window.addEventListener("storage", onStorage)
  whenLeaving(() => { polls.abort(); clearTimeout(wakes); window.removeEventListener("storage", onStorage) })
  if (!redraw) whenDropped(() => { dropCard(); instead = null })
  // the same order drawn again stays on screen until it is read, rather than blanking to a loading line
  if (redraw) document.querySelector("main")?.setAttribute("aria-busy", "true")
  else drawLoading("Opening the order…", asStep)
  void follow(mine, invoiceId, registrationId, polls.signal)
}

function dispatch(event: OrderEvent): void {
  const before = state
  state = reduce(state, event)
  if (!isRoute(pageRoute)) return
  const kind = screenOf(state)
  document.querySelector("main")?.removeAttribute("aria-busy")
  if (cardStays(before, kind)) showCard()
  else draw(kind, (signal) => asStep(BUILDERS[kind](state, signal)))
  if (kind !== "pay-card") dropCard()
  if (kind === "registered") seenRegistered(state.view!, state.invoice)
  if (revealDue(state)) reveal(state.view!, state.record!)
  // keepCodes dispatches record-changed itself, so it runs only when the screen or the record moved
  if (kind !== screenOf(before) || state.record !== before.record) keepCodes(state)
  wakeOnTime()
}

function wakeOnTime(): void {
  clearTimeout(wakes)
  const at = wakeAt(state)
  if (at !== null) wakes = setTimeout(() => dispatch({ type: "tick", now: api.serviceNow() }), at - api.serviceNow())
}

const isOpen = (gen: number) => gen === opened && isRoute(pageRoute)

const answer = (gen: number, event: OrderEvent) => { if (isOpen(gen)) dispatch(event) }
const reread = (gen: number) => { if (isOpen(gen)) refresh() }

function holdOn(e: unknown, lead: string, gen: number): boolean {
  if (!holdFrom(e)) return false
  if (isOpen(gen)) dispatch({ type: "hold-started", until: holdEnd(), lead })
  return true
}

const holdEnds = (signal: AbortSignal) => holdEnder(signal, () => dispatch({ type: "hold-ended" }))

const cardSubmittedAt = (invoice: api.InvoiceView | null, record: store.OrderRecord | undefined) =>
  record?.cardSubmittedAt ?? (invoice ? store.cardSubmittedAt(invoice.invoiceId) : undefined) ?? null

async function follow(mine: number, invoiceId: string | null, registrationId: string | null, signal: AbortSignal): Promise<void> {
  let invoice: api.InvoiceView | null = null
  let view: api.RegistrationView | null = null
  let drawn = ""
  let drawnRecord = ""
  // siblings that could not be read are asked again even when the order's own answer has not changed
  let again = false
  let codeChecked = false
  let unreadReads = 0
  // forgetting the last answer makes the next read answer at once
  const forget = () => {
    invoice = null
    view = null
  }
  while (isRoute(mine)) {
    const asked = Date.now()
    const seq = ++reads
    try {
      if (invoiceId) {
        invoice = await api.readInvoice(invoiceId, invoice ? api.seenOf(invoice) : undefined, signal)
        view = invoice.registration
      } else {
        view = await api.readRegistration(registrationId!, view?.version, signal)
      }
    } catch (e) {
      if (!isRoute(mine)) return
      if (e instanceof api.ApiError && e.code === "not_found") {
        // The service forgets an unpaid order some time after it closes; this browser may know what replaced it, or its
        // code may find it.
        const known = registrationId ? store.orderByRegistration(registrationId) : invoiceId ? store.orderByInvoice(invoiceId) : undefined
        if (known?.replacedBy) return redirect(known.replacedBy)
        let newer: store.OrderRecord | null
        try {
          newer = known ? await flow.newerOrder(known) : null
        } catch (e) {
          // the code's orders could not be asked for now; the link may still work, so the page asks again
          if (!isRoute(mine)) return
          const wait = api.retryDelay(e, RETRY_MS)
          if (wait === null) return dispatch({ type: "not-found" })
          dispatch({ type: "read-failed" })
          await sleep(wait)
          continue
        }
        if (!isRoute(mine)) return
        return newer ? redirect(store.orderUrl(newer)) : dispatch({ type: "not-found" })
      }
      dispatch({ type: "read-failed" })
      await sleep(e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS)
      continue
    }
    if (!isRoute(mine)) return
    const pause = view.unread.length ? unreadDelay(unreadReads++) : null
    if (pause === null) unreadReads = 0
    const paced = async () => {
      if (pause === null) return false
      await sleep(pause)
      forget()
      return true
    }
    const answered = JSON.stringify(invoice ?? view)
    if (answered === drawn && !again) {
      // one answered unchanged at once would otherwise poll in a tight loop
      if (!await paced() && Date.now() - asked < RETRY_MS) await sleep(RETRY_MS)
      continue
    }
    again = false
    let record = store.orderByRegistration(view.id) ?? (invoiceId ? store.orderByInvoice(invoiceId) : undefined)
    if (record) {
      const synced = await flow.syncRecord(record, view)
      if (!isRoute(mine)) return
      record = synced ?? undefined
    }
    // A late payment to a replaced invoice keeps its page, which says how support refunds it. Only a browser without this
    // order's record looks for its successor among its records, so two empty invoices never lead to each other.
    let unread: number | null = null
    try {
      const closedEmpty = invoice !== null && api.closedEmpty(invoice)
      const successor = closedEmpty && !record ? await nextOrder(view, invoice!) : undefined
      let replacement = successor && store.orderUrl(successor)
      if (!replacement && !record && invoice) record = await adoptSibling(view, invoice)
      if (!replacement && closedEmpty) replacement = record?.replacedBy
      // another browser may have made a newer invoice that this one never opened
      if (!replacement && closedEmpty && record) {
        const newer = await flow.newerOrder(record)
        replacement = newer ? store.orderUrl(newer) : undefined
      }
      if (!isRoute(mine)) return
      if (replacement) return redirect(replacement)
    } catch (e) {
      // a sibling's invoice could not be read; the page shows the order as this browser knows it and reads it again
      unread = api.retryDelay(e, RETRY_MS)
    }
    if (!isRoute(mine)) return
    if (view.phase !== "failed") codeChecked = false
    if (invoice && invoice.status !== "open") store.clearCardSubmitted(invoice.invoiceId)
    if (invoice && invoice.status !== "open" && record?.cardSubmittedAt) {
      store.updateOrder(record.registrationId, { cardSubmittedAt: undefined })
      record = { ...record, cardSubmittedAt: undefined }
    }
    record = (record && store.orderByRegistration(record.registrationId)) ?? record
    const recorded = JSON.stringify(record ?? null)
    if (answered !== drawn || recorded !== drawnRecord) {
      drawn = answered
      drawnRecord = recorded
      dispatch({ type: "answered", seq, now: api.serviceNow(), invoice, view, record: record ?? null, cardSubmittedAt: cardSubmittedAt(invoice, record) })
    }
    // A failed order is drawn before its code is checked, saying nothing of the code until the check answers.
    if (view.phase === "failed" && !codeChecked && !invoice && record?.prepaidCode && !record.codeRefusal) {
      codeChecked = true
      const spent = await codeSpent(record.prepaidCode)
      if (!isRoute(mine)) return
      if (spent) {
        store.updateOrder(record.registrationId, { codeRefusal: "code_used" })
        record = store.orderByRegistration(record.registrationId) ?? record
        drawnRecord = JSON.stringify(record)
        dispatch({ type: "record-changed", record, cardSubmittedAt: cardSubmittedAt(invoice, record) })
      } else if (spent === false) dispatch({ type: "code-checked" })
    }
    // a finished order whose siblings could not be read is read once more before the page stops following it
    if (finished(invoice, view) && unread === null) return
    if (await paced()) continue
    if (unread !== null && invoice?.status !== "open") {
      await sleep(unread)
      forget()
      again = true
    }
  }
}

// Another order of the same buyer: one of this commitment, or of the code's wallet once it moved to another name.
const siblingOf = (view: api.RegistrationView) => (o: store.OrderRecord) => o.registrationId !== view.id &&
  (o.request.commitment === view.commitment || o.owner.toLowerCase() === view.owner.toLowerCase())

// The same order with a later invoice. Only an invoice that closes later can have replaced this one; expiry times are
// whole seconds, so a tie counts.
async function nextOrder(view: api.RegistrationView, invoice: api.InvoiceView): Promise<store.OrderRecord | undefined> {
  const candidates = store.orders().filter((o) => o.invoiceId && !o.replacedBy && siblingOf(view)(o))
  for (const o of candidates) {
    // a sibling the service has forgotten replaced nothing; any other failure leaves the answer unknown
    const other = await api.readInvoice(o.invoiceId!).catch((e) => { if (e instanceof api.ApiError && e.code === "not_found") return null; throw e })
    if (other && Date.parse(other.expiresAt) >= Date.parse(invoice.expiresAt)) return o
  }
  return undefined
}

// A browser holding the code of another invoice of this order holds this one too: another browser may have made a newer
// invoice, or money may have reached an older one late. The code reopens the name when the order has moved to another one.
async function adoptSibling(view: api.RegistrationView, invoice: api.InvoiceView): Promise<store.OrderRecord | undefined> {
  const sibling = store.orders().find(siblingOf(view))
  if (!sibling) return undefined
  const closed = invoice.status !== "open" && view.phase === "unpaid"
  const next = closed ? await nextOrder(view, invoice) : undefined
  const record: store.OrderRecord = { ...sibling, registrationId: view.id, invoiceId: invoice.invoiceId,
    method: invoice.cryptoCurrency ?? "card", paid: view.price,
    cancelled: false, cardSubmittedAt: undefined, takenCode: undefined, prepaidCode: undefined, replacedBy: next && store.orderUrl(next),
    // a replaced invoice came just before its replacement; otherwise the code asks the service when the order was made,
    // which a later search for a newer order compares against
    createdAt: next ? new Date(Date.parse(next.createdAt) - 1).toISOString() : await flow.createdAtOf(sibling, view.id).catch(() => null) ?? new Date(api.serviceNow()).toISOString() }
  const adopted = await flow.syncRecord(record, view)
  if (adopted === record) store.saveOrder(record)
  if (adopted && !adopted.replacedBy) await replaceOlder(view, invoice)
  return adopted ?? undefined
}

// The older invoices of an order adopted here were replaced by it, as if this browser had asked for the new invoice.
async function replaceOlder(view: api.RegistrationView, invoice: api.InvoiceView): Promise<void> {
  for (const o of store.orders().filter((r) => r.invoiceId && !r.replacedBy && siblingOf(view)(r))) {
    const old = await api.readInvoice(o.invoiceId!).catch(() => null)
    if (old && old.status !== "open" && old.registration.phase === "unpaid" && Date.parse(old.expiresAt) <= Date.parse(invoice.expiresAt)) {
      store.updateOrder(o.registrationId, { replacedBy: store.orderUrl({ invoiceId: invoice.invoiceId, registrationId: view.id }) })
    }
  }
}

// An expired invoice is still followed: a payment can arrive after it closed, and then nothing must be ordered again.
// A taken or failed order is followed too, since another tab or browser can move, retry or turn it into a code.
function finished(invoice: api.InvoiceView | null, view: api.RegistrationView): boolean {
  if (["registered", "code_issued"].includes(view.phase)) return true
  return view.phase === "unpaid" && invoice?.status === "paid"
}

function reveal(view: api.RegistrationView, record: store.OrderRecord): void {
  const key = revealKey(view)
  const reference = state.reference
  dispatch({ type: "reveal-sent", key })
  flow.revealOrder(view, record).catch((e) => {
    // links the service refuses are in the commitment, so signing again cannot fix them: the order has to move
    if (e instanceof api.ApiError && e.code === "invalid_link") {
      store.updateOrder(record.registrationId, { linksRefused: true })
      // the record is changed first, so the reveal's end does not send it again
      if (isRoute(pageRoute) && state.reference === reference) dispatch({ type: "record-changed", record: { ...record, linksRefused: true }, cardSubmittedAt: state.cardSubmittedAt })
      dispatch({ type: "reveal-failed", key })
      return
    }
    const refused = e instanceof api.ApiError && e.code === "bad_request"
    setTimeout(() => {
      dispatch({ type: refused ? "reveal-refused" : "reveal-failed", key })
      if (isRoute(pageRoute) && state.reference === reference) refresh()
    }, e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS)
  })
}

function keepCodes(s: OrderState): void {
  const { view, record, invoice, cardSubmittedAt: submitted } = s
  if (!view || !record) return
  const kind = screenOf(s)
  if (kind === "code-issued" && !record.takenCode && view.codeLength !== null) {
    const code = flow.takenCodeOf(record, view)
    store.updateOrder(record.registrationId, { takenCode: code })
    store.addCode({ code, minLength: view.codeLength, years: view.years, addedAt: new Date().toISOString() })
    dispatch({ type: "record-changed", record: { ...record, takenCode: code }, cardSubmittedAt: submitted })
  }
  const released = kind === "taken" && !invoice ? releasedCode(view, record) : null
  if (released && !store.codes().some((c) => c.code === released.code)) store.addCode({ ...released, addedAt: new Date().toISOString() })
}

function releasedCode(view: api.RegistrationView, record: store.OrderRecord | null): Omit<store.CodeRecord, "addedAt"> | null {
  const parsed = record?.prepaidCode ? parseNameCode(record.prepaidCode) : null
  return parsed?.kind === "prepaid" ? { code: parsed.display, minLength: parsed.minLength, years: view.years } : null
}

// holdsFor is the screen's signal where the screen holds an action for the tab's wait
export const noteBox = (note: Note) => alertBox(note.tone, note.icon, note.title, note.link ? [note.text, el("a", { href: note.link.href }, note.link.text), note.link.after] : note.text)

function noteOf({ hold, note }: OrderState, holdsFor: AbortSignal | null): HTMLElement | null {
  if (holdsFor && hold) return holdNotice(hold, holdsFor)
  return note && noteBox(note)
}

const actionNote = (s: OrderState, holdsFor: AbortSignal | null) => keptLive(ORDER_NOTE, undefined, noteOf(s, holdsFor))

function buildUnreadable({ reference }: OrderState): HTMLElement {
  return outcome({ tone: "warn", icon: "alert", title: "This order could not be loaded", text: "The page keeps trying. If it does not load, quote the reference below.", reference })
}

function buildUnknownLink(): HTMLElement {
  return outcome({ tone: "info", icon: "link", title: "This link does not work", text: "It names no order this service knows. Check the link, or start again.",
    action: btn("Search a name", "", () => go("/#/")) })
}

function buildPaidByInvoice({ view, record }: OrderState): HTMLElement {
  return outcome({ tone: "info", icon: "link", title: "This order is paid by invoice", text: "Its page is the payment link it was made with.",
    action: record?.invoiceId ? btn("Open its payment", "", () => go(store.orderUrl(record))) : btn("Search a name", "quiet", () => go(searchLink(""))),
    reference: view!.id })
}

// a browser without the order's record learns the name only once it is revealed on chain
const labelOf = (view: api.RegistrationView, record: store.OrderRecord | null) => view.label ?? record?.label ?? null
const UNKNOWN_NAME = "The name shows once it is registered"

// what the order is for and what it cost, after its name where the screen has not said it already
const termLine = ({ view, invoice }: OrderState): Kid[] => invoice ? [el("span", { class: "nowrap" }, `${dollars(invoice.amount)} / ${view!.years} years`)]
  : [el("span", { class: "nowrap" }, `${view!.years} years`), SEP, "With a code"]

// the order in one line, the lead of each screen that pays or registers it
function orderLine(s: OrderState): Kid[] {
  const label = labelOf(s.view!, s.record)
  return [label ? nameText(label, s.view!.tld) : UNKNOWN_NAME, SEP, ...termLine(s)]
}

const TICKER: Record<"btc" | "xmr", string> = { btc: "BTC", xmr: "XMR" }
const WALLET = "Open in wallet"

// the invoice an earlier try made, which a checkout opened in place of paying as it chose; said until its page is left
let instead: { invoiceId: string; had: string; chosen: string } | null = null
export const openedInstead = (opened: typeof instead) => { instead = opened }
const methodWord = (method: string) => method === "card" ? "card" : methodName(method)
const insteadLine = (invoice: api.InvoiceView) => instead?.invoiceId !== invoice.invoiceId ? null : el("p", { class: "note" },
  `This name already has a ${methodWord(instead.had)} invoice from an earlier try, so it opened instead of ${instead.chosen === "code" ? "using your code" : `a new ${methodWord(instead.chosen)} one`}.`)

function copyField(label: string, value: string): HTMLElement {
  // A long value, as an address, may break between any two letters, which the field's balance evens out: WebKit
  // balances only between the breaks it is given, Firefox only in a word that breaks anywhere (.word).
  const shown = [...value].flatMap((ch, i) => i ? [el("wbr"), ch] : [ch])
  return el("div", { class: "copy-field" }, el("span", { class: "label" }, label),
    el("div", { class: "val" }, el("span", { class: "word" }, ...shown), copyButton(value, "field-copy", `Copy ${label}`)))
}

function rateLine(invoice: api.InvoiceView, signal: AbortSignal): HTMLElement {
  const left = () => (Date.parse(invoice.expiresAt) - api.serviceNow()) / 1000
  const time = el("span", {})
  onTheSecond(left, () => { time.textContent = clock(left()) }, signal)
  return el("span", {}, "Rate held ", time)
}

const partSeen = (invoice: api.InvoiceView, coin: "btc" | "xmr") => `Part of the payment arrived: ${invoice.cryptoAmountPaid} of ${invoice.cryptoAmount} ${TICKER[coin]} is seen.`
const restAsked = (invoice: api.InvoiceView, coin: "btc" | "xmr") => `Send the remaining ${invoice.cryptoAmountDue} ${TICKER[coin]} to the same address.`
const RATE_EXPIRED = "The rate expired before the full amount arrived. Don't send more; what you sent is refunded."

// A part-paid invoice stays open past its rate window until it closes, and past the window asks for no more: of its
// payment controls only the address stays. When the window ends in view, the words and controls that ask for more are
// hidden in place, so nothing on the screen moves.
function partLines(invoice: api.InvoiceView, coin: "btc" | "xmr", payMore: (HTMLElement | null)[], signal: AbortSignal): { notice: Kid; rate: HTMLElement; ended: boolean } {
  const left = () => (Date.parse(invoice.expiresAt) - api.serviceNow()) / 1000
  if (left() <= 0) return { notice: partSeen(invoice, coin), rate: el("span", {}, RATE_EXPIRED), ended: true }
  const rest = el("span", {}, restAsked(invoice, coin))
  const time = el("span", {})
  const held = el("span", {}, "Waiting for the rest of the payment", SEP, "Rate held ", time)
  const expired = el("span", { class: "sizer" }, RATE_EXPIRED)
  onTheSecond(left, () => {
    if (left() > 0) time.textContent = clock(left())
    else if (expired.classList.contains("sizer")) {
      for (const node of [rest, held, ...payMore]) node?.classList.add("sizer")
      expired.classList.remove("sizer")
    }
  }, signal)
  return { notice: [partSeen(invoice, coin), " ", rest], rate: el("span", { class: "sized" }, held, expired), ended: false }
}

function cancelLink(s: OrderState): HTMLAnchorElement {
  const working = s.busy === "cancel"
  const cancel = link(working ? "Cancelling…" : "Cancel this invoice", () => void cancelInvoice())
  cancel.classList.add("danger-link")
  cancel.dataset.focus = "cancel"
  if (working) cancel.setAttribute("aria-disabled", "true")
  return cancel
}

function buildPayCrypto(s: OrderState, signal: AbortSignal): HTMLElement {
  const inv = s.invoice!
  const coin = coinOf(inv)!
  const partial = Number(inv.cryptoAmountPaid ?? "0") > 0
  const due = partial ? inv.cryptoAmountDue! : inv.cryptoAmount!
  const uri = paymentUri(coin, inv.address!, due)
  holdEnds(signal)(s.hold !== null)
  const qr = uri ? el("div", { class: "card qr" }, qrSvg(uri, `${methodName(coin)} payment`), el("a", { href: uri }, WALLET)) : null
  // labels in sentence case, as their copy buttons say them; the label style draws them in capitals
  const amount = copyField(`${partial ? "rest to send" : "amount"} in ${TICKER[coin]}`, due)
  const address = copyField(`${methodName(coin)} address`, inv.address!)
  const wallet = uri ? el("a", { class: "wallet", href: uri }, WALLET) : null
  const part = partial ? partLines(inv, coin, [qr, amount, wallet], signal) : null
  // a part paid takes the bookmark's sentence with its notice; a phone opens its wallet from the link under the address, a laptop from the QR's card
  return screen({ title: `Pay with ${methodName(coin)}`, lead: [...orderLine(s), partial ? null : [". ", el("span", { class: "nowrap" }, "Bookmark this page to come back to it.")]],
    alt: partial ? null : cancelLink(s) },
    part ? alertBox("warn", "alert", null, part.notice) : null,
    insteadLine(inv),
    part?.ended ? address : el("div", { class: "qr-grid" }, qr, amount, address),
    part?.ended ? null : wallet,
    el("div", { class: "note waiting" }, part ? part.rate : el("span", {}, "Waiting for payment", SEP, rateLine(inv, signal)), referenceLine(inv.invoiceId)),
    // a wait the tab is in shows why the link does nothing until it is over
    actionNote(s, partial ? null : signal))
}

// The Stripe frame reloads, losing what was typed, whenever its form moves in the page; so while the card screen stays
// for the same invoice, a change shows on Pay and its note where they are, as the badge store's card form does.
let card: MountedCard | null = null
// the form a card is mounted in, or being mounted in; a mount that answers after it was dropped is destroyed
let cardIn: HTMLElement | null = null
let cardMounts = 0
let payButton: HTMLButtonElement | null = null
// without a Stripe key in development, Pay does what a submitted card does; the mock's controls settle it
const STAND_IN: MountedCard = { confirm: async () => ({ kind: "submitted" }), destroy: () => undefined }

function dropCard(): void {
  cardMounts += 1
  card?.destroy()
  card = null
  cardIn?.replaceChildren()
  cardIn = null
  payButton = null
}

function mountInto(form: HTMLElement, invoice: api.InvoiceView): void {
  const mine = ++cardMounts
  cardIn = form
  const key = publishableKey()
  if (!key && import.meta.env.DEV) {
    cardStandIn(form)
    card = STAND_IN
    return
  }
  void mountCard(key, invoice.clientSecret ?? "", form, isDark()).then((mounted) => {
    if (mine !== cardMounts) return mounted?.destroy()
    if (!mounted) return dispatch({ type: "card-failed" })
    card = mounted
    showCard()
  })
}

const cardStays = (before: OrderState, kind: OrderKind) =>
  payButton !== null && kind === "pay-card" && screenOf(before) === "pay-card" && before.invoice?.invoiceId === state.invoice?.invoiceId

function showCard(): void {
  if (!payButton) return
  setAction(payButton, state.busy === "card", card === null)
  document.querySelector('body > main [data-focus="cancel"]')?.replaceWith(cancelLink(state))
  actionNote(state, null)
}

async function payByCard(): Promise<void> {
  if (state.busy || !card) return
  const gen = opened
  const { invoice, record } = state
  dispatch({ type: "card-started" })
  const confirmed = await card.confirm()
  if (!isOpen(gen)) return
  if (confirmed.kind !== "submitted") return dispatch({ type: "card-refused", note: confirmed.kind === "error" ? { tone: "danger", icon: "alert", title: null, text: confirmed.message } : null })
  // The page knows the card was submitted without asking the service, so it shows that at once, in an outage too.
  const at = new Date(api.serviceNow()).toISOString()
  store.markCardSubmitted(invoice!.invoiceId, at)
  if (record) store.updateOrder(record.registrationId, { cardSubmittedAt: at })
  dispatch({ type: "card-submitted", at })
}

function buildPayCard(s: OrderState): HTMLElement {
  const invoice = s.invoice!
  const form = kept("stripe-form", () => el("div", { class: "stripe" }))
  if (cardIn !== form) mountInto(form, invoice)
  payButton = setAction(btn(`Pay ${dollars(invoice.amount)}`, "", () => void payByCard()), s.busy === "card", card === null)
  payButton.dataset.focus = "pay"
  // a submitted card is remembered only in storage; without it, a reload would offer the form again
  const forgetful = store.canPersist() ? null : alertBox("warn", "alert", "This browser cannot remember a card payment",
    "After paying, keep this page open until it moves on. Reloading would show the card form again.")
  return screen({ title: "Pay by card", lead: orderLine(s), action: payButton, alt: cancelLink(s) }, insteadLine(invoice), forgetful, form,
    el("p", { class: "note center" }, "The card form is Stripe's. Nothing is charged until you pay."), actionNote(s, null))
}

function cardStandIn(form: HTMLElement): void {
  const f = (text: string, value: string) => el("label", { class: "f" }, el("span", {}, text), el("div", { class: "box" }, value))
  form.append(el("div", { class: "label" }, el("span", {}, "Stripe's payment form"), el("span", {}, "Development: no card is checked.")),
    f("Card number", "4242 4242 4242 4242"), el("div", { class: "cols" }, f("Expiry", "12 / 30"), f("CVC", "123"), f("Country", "Portugal")))
}

// what a browser without the order's record can do: take in the name code
const withoutRecord = (cls: string, text = "Enter your name code") => btn(text, cls, () => go(CODE_FROM_ORDER_URL))

const CLOSED_TITLE = "Invoice closed"
const partlyPaid = (invoice: api.InvoiceView) => Number(invoice.cryptoAmountPaid ?? "0") > 0

function buildClosed(s: OrderState, signal: AbortSignal): HTMLElement {
  const inv = s.invoice!
  const closed = closedCase(s)!
  const [tone, text] = closedWords(closed, inv)
  // only a new invoice is held for the tab's wait
  const reorders = (closed === "received" || closed === "expired") && s.record !== null && !s.record.replacedBy
  holdEnds(signal)(s.hold !== null)
  return outcome({ tone, icon: "alert", title: CLOSED_TITLE, text, reference: inv.invoiceId,
    extra: actionNote(s, reorders ? signal : null), action: closedAction(s, closed) })
}

function closedWords(closed: ClosedCase, inv: api.InvoiceView): [Tone, Kid] {
  switch (closed) {
    case "paid-late": return ["warn", "The payment arrived after this invoice had closed, so nothing was registered. Support refunds it: quote the reference below."]
    case "cancelled": return ["info", "This invoice was cancelled and nothing was received."]
    case "received": {
      const coin = coinOf(inv)
      const arrived = coin && partlyPaid(inv) && !inv.paidInFull ? `${inv.cryptoAmountPaid} ${TICKER[coin]} arrived, which is not the full amount.` : "A payment did not complete before the invoice closed."
      return ["warn", [`${arrived} Write to `, el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), " with the reference below and we will sort it out."]]
    }
    case "expired": return ["info", inv.cryptoCurrency ? "Nothing was received before its rate window closed." : "Nothing was paid before it closed."]
  }
}

// a new invoice is a new order of this order's name code, which only the browser holding it can make
function closedAction(s: OrderState, closed: ClosedCase): HTMLButtonElement {
  const { record } = s
  if (record?.replacedBy) return btn("Open the new invoice", "quiet", () => go(record.replacedBy!))
  if (closed === "paid-late") return btn("Search a name", "quiet", () => go(searchLink("")))
  if (!record) return withoutRecord("quiet")
  if (closed === "cancelled") {
    const again = setAction(btn("Order the name again", "", () => void orderAgain(record)), s.busy === "reorder", s.hold !== null)
    again.dataset.focus = "reorder"
    return again
  }
  return newInvoiceButton(s, closed === "received" && !record.cancelled ? "quiet" : "", reorder)
}

// A cancelled order is ordered again on Check your order, with the same name code, saved already, and the same links.
async function orderAgain(record: store.OrderRecord): Promise<void> {
  const gen = opened
  dispatch({ type: "reorder-started" })
  let quote: Awaited<ReturnType<typeof flow.quoteOf>>
  try {
    quote = await flow.quoteOf(record.label)
  } catch (e) {
    if (holdOn(e, "Nothing was charged. ", gen)) return
    return answer(gen, { type: "reorder-failed", note: warning("The name could not be checked now. Try again in a moment.") })
  }
  if (!isOpen(gen)) return
  if (!quote) return go(searchLink(record.label))
  session.setCheckout({
    label: record.label, price: quote.price, years: quote.years, termStart: quote.termStart, chain: flow.chainOf(quote), contact: record.contact, channel: record.channel,
    method: record.method === "code" ? "btc" : record.method, code: null, ownerCode: record.ownerCode, saved: true, searchAt: historyPlace(), step: "review",
  })
  go(checkoutUrl("review"))
}

function newInvoiceButton(s: OrderState, cls: string, get: () => void): HTMLButtonElement {
  const again = setAction(btn("Get a new invoice", cls, get), s.busy === "reorder", s.hold !== null)
  again.dataset.focus = "reorder"
  return again
}

// A card never submitted is on this screen only because its form failed to load.
function buildCardUnconfirmed(s: OrderState, signal: AbortSignal): HTMLElement {
  const inv = s.invoice!
  const formFailed = s.cardSubmittedAt === null
  holdEnds(signal)(s.hold !== null)
  return outcome({ tone: "warn", icon: "alert", title: "Card payment not confirmed", reference: inv.invoiceId,
    text: formFailed ? "Stripe's form was blocked or failed to load. Nothing was charged."
      : "The payment has not been confirmed. This page keeps checking: come back to it later, or quote the reference below.",
    extra: actionNote(s, formFailed && s.record !== null ? signal : null), action: cardAction(s, formFailed), alt: formFailed && s.record ? coinLinks(s) : null })
}

// a card form that did not load leaves the coins: each cancels the card invoice and orders the name again paid with it
function coinLinks(s: OrderState): HTMLElement {
  const coin = (method: "btc" | "xmr") => {
    const pay = link(`Pay with ${methodName(method)}`, () => void reorderAfterCancel(method))
    if (s.busy !== null || s.hold !== null) pay.setAttribute("aria-disabled", "true")
    return pay
  }
  return el("span", {}, coin("btc"), SEP, coin("xmr"))
}

// Once the service has seen a card payment, entering the card again could charge twice.
function cardAction(s: OrderState, formFailed: boolean): HTMLButtonElement | null {
  if (formFailed) return s.record ? newInvoiceButton(s, "", () => void reorderAfterCancel()) : withoutRecord("")
  return s.invoice!.amountPaid ? null : btn("Enter the card again", "", enterCardAgain)
}

async function reorderAfterCancel(method: api.Method = "card"): Promise<void> {
  if (state.busy || state.hold) return
  const gen = opened
  const invoice = state.invoice!
  dispatch({ type: "reorder-started" })
  if (await cancelBeforeReorder(invoice, gen)) return newInvoice(invoice, store.orderByInvoice(invoice.invoiceId), gen, method)
  if (store.orderByInvoice(invoice.invoiceId)?.cancelled) reread(gen)
}

// The old invoice is cancelled before a new one is ordered; true when ordering again cannot charge twice.
async function cancelBeforeReorder(invoice: api.InvoiceView, gen: number): Promise<boolean> {
  const say = (text: string) => answer(gen, { type: "reorder-failed", note: warning(text) })
  let after: api.InvoiceView
  try {
    after = await api.cancelInvoice(invoice.invoiceId)
    const record = store.orderByInvoice(invoice.invoiceId)
    if (record && after.status !== "paid") store.updateOrder(record.registrationId, { cancelled: true })
  } catch (e) {
    const code = e instanceof api.ApiError ? e.code : "network"
    if (holdOn(e, "The invoice is still open. ", gen)) return false
    if (code !== "not_open") {
      say(code === "funded" ? "A payment has reached this invoice, so it is kept." : "The invoice could not be cancelled now. Try again in a moment.")
      return false
    }
    try {
      after = await api.readInvoice(invoice.invoiceId)
    } catch {
      say("The invoice could not be read now. Try again in a moment.")
      return false
    }
  }
  if (after.status === "paid" && after.registration.phase !== "unpaid") {
    if (isOpen(gen)) go(store.invoiceUrl(after.invoiceId))
    return false
  }
  if (after.status === "paid" || !api.holdsPayment(after)) return true
  say("A payment has reached this invoice, so it is kept. Quote the reference below.")
  return false
}

async function cancelInvoice(): Promise<void> {
  if (state.busy || state.hold) return
  const gen = opened
  const { invoice, record } = state
  dispatch({ type: "cancel-started" })
  try {
    const after = await api.cancelInvoice(invoice!.invoiceId)
    if (record && after.status !== "paid") store.updateOrder(record.registrationId, { cancelled: true })
    answer(gen, { type: "cancel-answered" })
    reread(gen)
  } catch (e) {
    // an invoice that closed meanwhile, or an order another request changed first, is shown as it is now
    if (e instanceof api.ApiError && (e.code === "not_open" || e.code === "registration_changed")) {
      answer(gen, { type: "cancel-answered" })
      return reread(gen)
    }
    if (e instanceof api.ApiError && e.code === "funded") return answer(gen, { type: "cancel-failed", note: warning("A payment has reached this invoice, so it cannot be cancelled.") })
    if (holdOn(e, "The invoice is still open. ", gen)) return
    answer(gen, { type: "cancel-failed", note: warning("The invoice could not be cancelled now. Try again in a moment.") })
  }
}

function buildConfirming(s: OrderState): HTMLElement {
  const invoice = s.invoice!
  const coin = coinOf(invoice)
  const notice = coin
    ? alertBox("info", "clock", confirmations(invoice.requiredConfirmations ?? 1),
      `${invoice.cryptoAmount} ${TICKER[coin]} arrived. Registration starts once it confirms; this page moves on by itself.`)
    : alertBox("info", "clock", "Waiting for Stripe to\u00a0confirm", "Stripe usually confirms within a minute. Registration starts by itself; this page moves on.")
  // a card Stripe has not confirmed can still be cancelled while nothing is paid, as an unpaid crypto invoice can
  const cancel = !coin && !invoice.amountPaid ? cancelLink(s) : null
  return screen({ title: coin ? "Confirming your payment" : "Paying by card", lead: orderLine(s), alt: cancel }, notice, referenceLine(invoice.invoiceId), actionNote(s, null))
}

function enterCardAgain(): void {
  const { invoice, record } = state
  store.clearCardSubmitted(invoice!.invoiceId)
  if (record) store.updateOrder(record.registrationId, { cardSubmittedAt: undefined })
  dispatch({ type: "record-changed", record: record && { ...record, cardSubmittedAt: undefined }, cardSubmittedAt: null })
}

function reorder(): void {
  const gen = opened
  const { invoice, record } = state
  dispatch({ type: "reorder-started" })
  void newInvoice(invoice!, record ?? undefined, gen)
}

function buildPriceChanged({ record, invoice, price }: OrderState): HTMLElement {
  const { label } = record!
  return outcome({ tone: "warn", icon: "alert", title: "The price changed", text: [nameText(label, invoice!.registration.tld), ` costs ${dollars(price!)} now. Nothing was charged.`],
    action: btn("Search again", "", () => go(searchLink(label))), reference: invoice!.invoiceId })
}

async function newInvoice(invoice: api.InvoiceView, record: store.OrderRecord | undefined, gen: number, method: api.Method = invoice.cryptoCurrency ?? "card"): Promise<void> {
  if (!isOpen(gen) || !record) return
  try {
    // the invoice as it is now: one still open, or paid into a registration, is the order; one paid after it closed
    // registered nothing, so the name is ordered again and support refunds the late payment
    const now = await api.readInvoice(invoice.invoiceId)
    if (now.status === "open" || (now.status === "paid" && now.registration.phase !== "unpaid")) {
      if (isOpen(gen)) go(store.invoiceUrl(invoice.invoiceId))
      return
    }
    // a new invoice is a new order of the same name code, at the price this one was made for
    const quote = await flow.quoteOf(record.label)
    if (!quote) {
      if (isOpen(gen)) go(searchLink(record.label))
      return
    }
    const built = await flow.orderRequest(flow.draftAgain(record, quote))
    const res = await api.createOrder(built.request, method, invoice.amount)
    const next = store.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id })
    // the old record is the stored owner code until the new one is stored too
    store.saveOrder({ ...record, request: built.request, registrationId: res.registration.id, invoiceId: res.invoiceId, ...flow.paidWith(res), cancelled: false, cardSubmittedAt: undefined, replacedBy: undefined, createdAt: new Date(api.serviceNow()).toISOString() })
    // Your names lists the old order only while money it received needs its reference; its page leads to the new one
    if (res.registration.id !== record.registrationId) store.updateOrder(record.registrationId, { replacedBy: next })
    if (isOpen(gen)) go(next)
  } catch (e) {
    if (!isOpen(gen)) {
      holdFrom(e)
      return
    }
    if (e instanceof api.ApiError && e.code === "name_taken") return go(searchLink(record.label))
    if (e instanceof api.ApiError && e.code === "order_exists") {
      const own = await flow.ownOrderFor(record.ownerCode, record.request.labelHash).catch(() => null)
      if (own && isOpen(gen)) return go(store.orderUrl(own))
    }
    if (e instanceof api.ApiError && e.code === "catalog_changed" && typeof e.body.price === "number") return dispatch({ type: "price-changed", price: e.body.price })
    if (e instanceof api.ApiError && e.code === "provider_unavailable") {
      return dispatch({ type: "reorder-failed", note: { tone: "warn", icon: "alert", title: `${methodName(method)} is unavailable right now`,
        text: "Nothing was charged. Try again later, or ", link: { text: "order the name again", href: searchLink(record.label), after: " to pay another way." } } })
    }
    if (holdOn(e, "Nothing was charged. ", gen)) return
    dispatch({ type: "reorder-failed", note: { tone: "warn", icon: "alert", title: "That did not go through", text: "Nothing was charged. Try again in a moment." } })
  }
}

type StageState = "done" | "active" | "failed" | ""
const STAGES = [
  { going: "Committing", done: "Committed" },
  { going: "Waiting", done: "Waiting" },
  { going: "Registering", done: "Registered" },
]

function stages(states: StageState[]): HTMLElement {
  return el("ol", { class: "stages", role: "list" }, ...STAGES.map((stage, i) => el("li", { class: `stage ${states[i]}`.trim() },
    el("b", {}, states[i] === "done" ? stage.done : stage.going))))
}

// the stage a registration is at, said once as it is reached, never each second of its wait
let saidStage = ""
function sayStage(view: api.RegistrationView, states: StageState[]): void {
  const at = states.indexOf("active")
  const stage = `${view.id} ${at}`
  if (at < 0 || stage === saidStage) return
  saidStage = stage
  announce(STAGES[at].going)
}

const stagesOf = (view: api.RegistrationView): StageState[] => view.phase === "registering" ? ["done", "done", "active"] : view.phase === "committed" ? ["done", "active", ""] : ["active", "", ""]

function headingOf({ view, record }: OrderState): Kid {
  const label = labelOf(view!, record)
  return label ? ["Registering ", gradName(label, view!.tld)] : "Registering the name"
}

const leadOf = ({ record }: OrderState) => record ? ["Keep this page open until the name is yours, ", el("span", { class: "nowrap" }, `or come back within ${REVEAL_HOURS} hours.`)]
  : "The browser with its name code signed it."

const WAIT_NOTE = "Every new name waits a little, so nobody who sees your order can take the name first."
const COMMIT_NOTE = "Placing your order. The wait starts once it is in."
const REGISTERING_NOTE = "Registering the name. It is yours in a moment."

function buildRegistering(s: OrderState, signal: AbortSignal): HTMLElement {
  const view = s.view!
  const states = stagesOf(view)
  sayStage(view, states)
  const refused = refusalsOf(s) >= REVEAL_ATTEMPTS
  const steps = stages(states)
  const clockNode = el("b", {})
  const note = el("span", {})
  const tryAgain = () => {
    dispatch({ type: "reveal-retried" })
    refresh()
  }
  const say = (node: HTMLElement, text: string) => { if (node.textContent !== text) node.textContent = text }
  // the wait's time, its line and the words under it move on each second between the screen's own changes
  const tick = () => {
    if (view.phase === "committed") fillWait(steps.children[1] as HTMLElement, view)
    const left = waitLeft(view)
    if (view.phase === "committed" && left > 0) {
      say(clockNode, clock(left))
      return say(note, WAIT_NOTE)
    }
    if (!clockNode.querySelector("svg")) clockNode.replaceChildren(icon("clock"))
    if (view.phase !== "committed") return say(note, view.phase === "registering" ? REGISTERING_NOTE : COMMIT_NOTE)
    waitsSeen.delete(view.id)
    if (view.label === null && refused) say(note, "The registration is not signed yet.")
    else say(note, REGISTERING_NOTE)
  }
  onTheSecond(() => waitLeft(view), tick, signal)
  return screen({ title: headingOf(s), lead: leadOf(s), action: refused ? btn("Try again", "", tryAgain) : null },
    steps,
    // the note keeps the height of its longest words, so the page keeps still as they change
    el("div", { class: "countdown" }, clockNode, el("p", {}, note, el("span", { class: "sizer", "aria-hidden": "true" }, WAIT_NOTE))),
    refused ? alertBox("danger", "alert", "The name could not be signed", "The service refused the signed registration.") : null,
    referenceLine(s.invoice?.invoiceId ?? view.id))
}

const waitsSeen = new Map<string, number>()
// a timed wait's bar starts this full, so as it becomes active it reads apart from the stages still to come
const WAIT_FILL_START = 0.08
const waitLeft = (view: api.RegistrationView) => (view.revealAfter ?? 0) - api.serviceNow() / 1000
function fillWait(stage: HTMLElement, view: api.RegistrationView): void {
  const now = api.serviceNow()
  const end = (view.revealAfter ?? 0) * 1000
  if (!waitsSeen.has(view.id)) waitsSeen.set(view.id, now)
  const start = waitsSeen.get(view.id)!
  const done = end > start ? Math.min(1, (now - start) / (end - start)) : 1
  stage.style.setProperty("--done", String(Math.max(WAIT_FILL_START, done)))
}

const TURN_SLACK_MS = 20
function onTheSecond(left: () => number, f: () => void, signal: AbortSignal): void {
  if (signal.aborted) return
  let id: ReturnType<typeof setTimeout> | undefined
  const next = () => {
    clearTimeout(id)
    f()
    const l = left()
    id = setTimeout(next, l > 0 ? (l % 1) * 1000 + TURN_SLACK_MS : 1000)
  }
  signal.addEventListener("abort", () => clearTimeout(id), { once: true })
  next()
}

// The order cannot register with the links it committed to; it moves to the same name without them, or to another name.
function buildLinksRefused(s: OrderState, signal: AbortSignal): HTMLElement {
  const view = s.view!
  const move = setAction(btn("Register without links", "", () => void moveWithoutLinks()), s.busy === "move", s.hold !== null)
  move.dataset.focus = "move"
  holdEnds(signal)(s.hold !== null)
  return screen({ title: headingOf(s), lead: orderLine(s), action: move, alt: link("Choose another name", () => go(`/#/?retarget=${view.id}`)) },
    alertBox("warn", "alert", "The service refused this order's links",
      "They are part of the order, so they cannot be changed in it. Register the name without them and add links in Your names once it is registered, or choose another name."),
    actionNote(s, signal),
    referenceLine(s.invoice?.invoiceId ?? view.id))
}

// what a move refused for good says: the service bounds how often an order moves, and support settles it from there
export const moveLimitNote = (reference: string): Note => ({ tone: "warn", icon: "alert", title: "This order cannot move again",
  text: "Write to SimpleX support with its reference, ", link: { text: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}`, after: `: ${reference}.` } })

async function moveWithoutLinks(): Promise<void> {
  const gen = opened
  const record = state.record!
  const reference = state.invoice?.invoiceId ?? state.view!.id
  dispatch({ type: "move-started" })
  try {
    const quote = await flow.quoteOf(record.label)
    if (!quote) return answer(gen, { type: "move-failed", note: warning("This name is no longer available. Choose another name.") })
    await flow.retargetOrder(record, record.label, { contact: "", channel: "" }, quote)
    reread(gen)
  } catch (e) {
    if (holdOn(e, "Nothing changed. ", gen)) return
    const limit = e instanceof api.ApiError && e.code === "move_limit"
    // an order another request moved first is shown as it is now
    if (e instanceof api.ApiError && e.code === "registration_changed") return reread(gen)
    answer(gen, { type: "move-failed", note: limit ? moveLimitNote(reference) : warning("That did not go through. Nothing changed. Try again in a moment.") })
  }
}

function buildNotOnDevice({ view, invoice }: OrderState): HTMLElement {
  return outcome({ tone: "info", icon: "key", title: "The name code is not in this browser",
    text: ["This order registers a name to ", el("span", { class: "nowrap" }, shortAddress(view!.owner)), ". Its code was made in the browser it was bought in. Enter the code you saved to carry on here."],
    action: btn("Enter your name code", "", () => go(CODE_FROM_ORDER_URL)), reference: invoice?.invoiceId ?? view!.id })
}

// a name of this browser's code needs nothing more from here; one of another browser's restores its code
const registeredAction = (record: store.OrderRecord | null) => record ? null : withoutRecord("", "Restore with your name code")

function buildRegistered(s: OrderState): HTMLElement {
  const view = s.view!
  const label = labelOf(view, s.record)
  const code = s.record?.ownerCode ?? null
  return screen({ title: [label ? gradName(label, view.tld) : "The name", " is\u00a0yours"], lead: registeredLead(view, s.record), action: registeredAction(s.record) },
    code ? [el("div", { class: "card use" }, el("h2", {}, "Use in the app"),
      el("p", {}, "In SimpleX, open Your SimpleX address, tap Set SimpleX name and enter ", nameText(label ?? "", view.tld, "."), " For a channel, set it in the channel's profile.")),
    el("p", { class: "note center" }, "Keep your name code: it owns the name and edits its links."),
    codeDisplay(code, "owner-code", true)] : null)
}

function registeredLead(view: api.RegistrationView, record: store.OrderRecord | null): string {
  const until = view.expiresAt ? dateOf(view.expiresAt) : ""
  return record ? `Registered until ${until}.` : `Registered until ${until} to ${shortAddress(view.owner)}. Its name code is not in this browser.`
}

function buildTakenWithCode({ view: taken, record }: OrderState): HTMLElement {
  const view = taken!
  const label = labelOf(view, record)
  const released = releasedCode(view, record)
  return outcome({ tone: "info", icon: "key", title: "Someone registered it first",
    text: [label ? nameText(label, view.tld) : "The name", " was registered just before ours. Your code was not spent: use it for another name."],
    extra: released ? codeDisplay(released.code) : null,
    action: btn("Search another name", "", () => go("/#/")),
    reference: view.id })
}

function buildTaken(s: OrderState, signal: AbortSignal): HTMLElement {
  const { view: taken, record, invoice } = s
  if (!invoice) return buildTakenWithCode(s)
  const view = taken!
  const label = labelOf(view, record)
  // the order's worth caps another name; after a move to a cheaper name it is lower than what was paid
  const worth = dollars(view.price)
  const canAct = record !== null
  const other = setAction(btn("Choose another name", "", () => go(`/#/?retarget=${view.id}`)), false, !canAct)
  // no code is offered when no length of name is as cheap as the order at today's prices
  const codeLength = view.codeLength
  const code = codeLength === null ? null : setAction(btn("Take a code", "quiet", () => void takeCode(codeLength)), canAct && s.busy === "code", !canAct || s.hold !== null)
  if (code) code.dataset.focus = "take-code"
  holdEnds(signal)(s.hold !== null)
  const cannot = canAct ? null : alertBox("info", "key", "The name code is not in this browser", "Add it in Check your code to choose another name or take a code.")
  return screen({ title: "Someone registered it first", lead: [label ? nameText(label, view.tld) : "The name", " was registered just before ours. Your payment is kept."],
    alt: code, action: other },
    el("p", { class: "note" }, ...termLine(s)),
    stages(["done", "done", "failed"]),
    el("p", { class: "note" }, `Choose another name of up to ${worth}, registered to the same wallet so your code owns it`,
      codeLength === null ? "." : `, or take a code for names of ${codeLength} or more letters, for ${view.years} years.`),
    cannot,
    actionNote(s, canAct ? signal : null),
    referenceLine(invoice.invoiceId))
}

async function takeCode(codeLength: number): Promise<void> {
  const gen = opened
  const view = state.view!
  const record = state.record!
  dispatch({ type: "code-started" })
  try {
    await flow.takeCodeFor(record, view, codeLength)
    return reread(gen)
  } catch (e) {
    // the code may have been issued with the answer lost, or another browser moved the order: the order says
    const now = await api.readRegistration(view.id).catch(() => null)
    const held = holdOn(e, "The code was not taken. ", gen)
    if (now && now.phase !== "taken") return reread(gen)
    if (!held) answer(gen, { type: "code-failed", note: warning("The code could not be taken now. Try again in a moment.") })
  }
}

function buildCodeIssued({ view: issued, record }: OrderState): HTMLElement {
  const view = issued!
  if (!record) {
    return outcome({ tone: "info", icon: "key", title: "This order became a code",
      text: "The code is made from the order's name code, so it shows in the browser that has it. Restore the name code here to see it.",
      action: btn("Enter your name code", "", () => go(CODE_FROM_ORDER_URL)), reference: view.id })
  }
  const code = record.takenCode ?? flow.takenCodeOf(record, view)
  return outcome({ tone: "ok", icon: "key", title: "Here is a code instead",
    text: [`For names of ${view.codeLength} or more letters, for ${view.years} years: what `, nameText(record.label, view.tld), " was paid for."],
    action: btn("Search another name", "quiet", () => go("/#/")),
    extra: [codeDisplay(code),
      el("div", { class: "code-qr" }, qrSvg(code, "code")),
      el("div", { class: "left" }, alertBox("info", "info", "Keep a copy of this code", "The service keeps only its hash; this browser keeps the code, under Your names."))] })
}

function buildFailed(s: OrderState, signal: AbortSignal): HTMLElement {
  const { view: failed, invoice } = s
  const view = failed!
  // a code refused for good leaves nothing to try again, so the page offers another search as the other endings do
  const retry = setAction(btn("Try again", "", () => void retryRegistration()), s.busy === "retry", s.hold !== null)
  retry.dataset.focus = "retry"
  const action = s.codeRefused ? btn("Search a name", "quiet", () => go(searchLink(""))) : retry
  holdEnds(signal)(s.hold !== null)
  const failedAt: StageState[] = view.commitTx === null ? ["failed", "", ""] : ["done", "done", "failed"]
  return screen({ title: invoice ? "Paid, not registered" : "Not registered", lead: failedLead(s), action },
    el("p", { class: "note" }, ...orderLine(s)),
    stages(failedAt),
    alertBox("danger", "alert", view.error ?? "The registration did not go through", "The service's own retries gave up."),
    actionNote(s, signal),
    referenceLine(invoice?.invoiceId ?? view.id))
}

// The refusal is kept with the order, so the page opened again says it from its first frame.
function keepRefusal(gen: number, error: store.CodeRefusal): void {
  const record = state.record
  if (!isOpen(gen) || !record) return
  store.updateOrder(record.registrationId, { codeRefusal: error })
  dispatch({ type: "record-changed", record: { ...record, codeRefusal: error }, cardSubmittedAt: state.cardSubmittedAt })
}

// Another order may have spent the code since this one failed, which a retry would only find out. A code revoked or
// expired may still be held by this registration, whose retry the service then takes, so only a spent one is refused.
// A code the service does not know (code_invalid), or revoked, was not spent; null when the service did not answer.
const codeSpent = (code: string) => api.checkCode(code).then(({ state }) => state === "used",
  (e) => e instanceof api.ApiError && e.code === "code_invalid" ? false : null)

async function retryRegistration(): Promise<void> {
  const gen = opened
  const view = state.view!
  dispatch({ type: "retry-started" })
  try {
    await api.retry(view.id)
  } catch (e) {
    // another tab may have retried it already
    const now = await api.readRegistration(view.id).catch(() => null)
    const held = holdOn(e, "Nothing changed. ", gen)
    if (now && now.phase !== "failed") return reread(gen)
    if (held) return
    const refusal = e instanceof api.ApiError ? retryRefusal(e.code) : null
    answer(gen, { type: "retry-failed", codeRefused: refusal?.kept != null, note: refusal?.note
      ?? { tone: "warn", icon: "alert", title: "That did not go through", text: "Nothing changed. Try again in a moment." } })
    if (refusal?.kept) keepRefusal(gen, refusal.kept)
    return
  }
  reread(gen)
}

const BUILDERS: Record<OrderKind, Builder<OrderState>> = {
  "pay-crypto": buildPayCrypto,
  "pay-card": buildPayCard,
  confirming: buildConfirming,
  registering: buildRegistering,
  "links-refused": buildLinksRefused,
  registered: buildRegistered,
  taken: buildTaken,
  "code-issued": buildCodeIssued,
  failed: buildFailed,
  "not-on-device": buildNotOnDevice,
  "status:closed": buildClosed,
  "status:card-unconfirmed": buildCardUnconfirmed,
  "status:paid-by-invoice": buildPaidByInvoice,
  "status:unreadable": buildUnreadable,
  "status:unknown-link": buildUnknownLink,
  "status:price-changed": buildPriceChanged,
}
