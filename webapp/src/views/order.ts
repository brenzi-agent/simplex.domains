// An order's page (?order=<invoice>) or a code registration's (?registration=<id>): payment, registration, and every ending.
import * as api from "../api.ts"
import { codeTier, LONGEST_TIER, parseNameCode } from "../crypto/code.ts"
import { alertBox, btn, codeDisplay, copyButton, el, gradName, icon, type Kid, link, nameText, setAction, type Tone } from "../dom.ts"
import * as flow from "../flow.ts"
import { clock, dateOf, dollars, methodName, SEP, shortAddress, termText } from "../format.ts"
import { PRICED_YEARS } from "../names.ts"
import { paymentUri, qrSvg } from "../qr.ts"
import {
  type ClosedCase, closedCase, coinOf, failedLead, initialState, type Note, openedFromApp, type OrderEvent, type OrderKind, type OrderState, reduce, refusalsOf,
  retryRefusal, REVEAL_ATTEMPTS, revealDue, revealKey, screenOf, wakeAt,
} from "../screens/order.ts"
import * as store from "../store.ts"
import { type MountedCard, mountCard, publishableKey } from "../stripe.ts"
import { every } from "./effects.ts"
import { seenRegistered } from "./names.ts"
import { holdEnd, holdEnder, holdFrom, holdNotice, tabHold } from "./hold.ts"
import { asStep, type Builder, CONTACT_EMAIL, currentRoute, draw, drawLoading, go, isDark, isRedraw, isRoute, kept, keptLive, outcome, redirect, referenceLine, refresh, screen, searchLink, whenDropped, whenLeaving } from "./shell.ts"

const RETRY_MS = 3000
// The badge service's words for a cancel the provider took while the service still shows the invoice open; a card
// invoice has no address. The browser keeps the cancel, so the warning stays until the invoice closes.
const cancelStillOpen = (invoice: api.InvoiceView) => invoice.cryptoCurrency
  ? "This invoice was cancelled, but the service still shows it open. Do not send anything more to the address."
  : "This invoice was cancelled, but the service still shows it open. Do not pay it again."

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
  else draw(kind, (signal) => asStep(BUILDERS[kind](state, signal)), kind === "pay-crypto" || kind === "pay-card" ? "payment" : null)
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

function answer(gen: number, event: OrderEvent): void {
  if (isOpen(gen)) dispatch(event)
}

function reread(gen: number): void {
  if (isOpen(gen)) refresh()
}

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
  while (isRoute(mine)) {
    const asked = Date.now()
    const seq = ++reads
    try {
      if (invoiceId) {
        const seen = invoice && { status: invoice.status, phase: invoice.registration.phase, paid: invoice.cryptoAmountPaid ?? "", full: invoice.paidInFull === true }
        invoice = await api.readInvoice(invoiceId, seen ?? undefined, signal)
        view = invoice.registration
      } else {
        view = await api.readRegistration(registrationId!, view?.phase, signal)
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
    const answered = JSON.stringify(invoice ?? view)
    if (answered === drawn && !again) {
      // one answered unchanged at once would otherwise poll in a tight loop
      if (Date.now() - asked < RETRY_MS) await sleep(RETRY_MS)
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
      let replacement = closedEmpty && !record ? await successorOf(view, invoice!) : undefined
      if (!replacement && !record && invoice) record = await adoptSibling(view, invoice)
      if (!replacement && closedEmpty) replacement = record?.replacedBy
      // another browser may have made a newer invoice that this one never opened
      if (!replacement && closedEmpty && record?.ownerCode) {
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
    // only a closed invoice reads siblings
    if (unread !== null && invoice?.status !== "open") {
      await sleep(unread)
      // forgetting the last answer makes the next read answer at once
      invoice = null
      view = null
      again = true
    }
  }
}

// Another order of the same buyer: one of this commitment, or of the code's wallet once it moved to another name.
// An order opened from the app shares its wallet with the app's other orders, so only its commitment counts.
const siblingOf = (view: api.RegistrationView) => (o: store.OrderRecord) => o.registrationId !== view.id &&
  (o.request.commitment === view.commitment || (o.ownerCode !== null && o.owner.toLowerCase() === view.owner.toLowerCase()))

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

async function successorOf(view: api.RegistrationView, invoice: api.InvoiceView): Promise<string | undefined> {
  const next = await nextOrder(view, invoice)
  return next && store.orderUrl(next)
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
  if (kind === "code-issued" && record.ownerCode && !record.takenCode) {
    const code = flow.takenCodeOf(record, view.id)
    store.updateOrder(record.registrationId, { takenCode: code })
    store.addCode({ code, minLength: codeTier(record.label.length), years: PRICED_YEARS, addedAt: new Date().toISOString() })
    dispatch({ type: "record-changed", record: { ...record, takenCode: code }, cardSubmittedAt: submitted })
  }
  const released = kind === "taken" && !invoice ? releasedCode(view, record) : null
  if (released && !store.codes().some((c) => c.code === released.code)) store.addCode({ ...released, addedAt: new Date().toISOString() })
}

function releasedCode(view: api.RegistrationView, record: store.OrderRecord | null): Omit<store.CodeRecord, "addedAt"> | null {
  const code = record?.prepaidCode
  if (!code) return null
  const parsed = parseNameCode(code)
  const minLength = parsed?.kind === "prepaid" ? parsed.minLength : codeTier(labelOf(view, record)?.length ?? LONGEST_TIER)
  return { code, minLength, years: view.years }
}

function noteNode(note: Note): HTMLElement {
  const text = note.link ? [note.text, el("a", { href: note.link.href }, note.link.text), note.link.after] : note.text
  return alertBox(note.tone, note.icon, note.title, text)
}

// holdsFor is the screen's signal where the screen holds an action for the tab's wait
function noteOf(s: OrderState, holdsFor: AbortSignal | null): HTMLElement | null {
  if (holdsFor && s.hold) return holdNotice(s.hold, holdsFor)
  return s.note ? noteNode(s.note) : null
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
    action: record?.invoiceId ? btn("Open its payment", "", () => go(store.orderUrl(record))) : btn("Search a name", "quiet", () => go(searchFrom(view!, record))),
    reference: view!.id })
}

// a browser without the order's record learns the name only once it is revealed on chain
const labelOf = (view: api.RegistrationView, record: store.OrderRecord | null) => view.label ?? record?.label ?? null
const UNKNOWN_NAME = "The name shows once it is registered"

function orderLine({ view, record, invoice }: OrderState): HTMLElement {
  const label = labelOf(view!, record)
  return el("p", { class: "note" }, label ? nameText(label, view!.tld) : UNKNOWN_NAME, SEP, el("span", { class: "nowrap" }, termText(view!.years)), SEP,
    invoice ? dollars(invoice.amount, true) : "With a code")
}

const TICKER: Record<"btc" | "xmr", string> = { btc: "BTC", xmr: "XMR" }

// the invoice an earlier try made, which a checkout opened in place of paying as it chose; said until its page is left
let instead: { invoiceId: string; had: string; chosen: string } | null = null
export const openedInstead = (opened: typeof instead) => { instead = opened }
// a method as a sentence names it
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
  const end = Date.parse(invoice.expiresAt)
  const time = el("span", {})
  const turn = () => { time.textContent = clock((end - api.serviceNow()) / 1000) }
  turn()
  every(1000, turn, signal)
  return el("span", {}, "Rate held ", time)
}

const partSentence = (invoice: api.InvoiceView, coin: "btc" | "xmr") =>
  `${invoice.cryptoAmountPaid} of ${invoice.cryptoAmount} ${TICKER[coin]} is seen. Send the remaining ${invoice.cryptoAmountDue} ${TICKER[coin]} to the same address.`

function cancelLink(s: OrderState): HTMLAnchorElement {
  const working = s.busy === "cancel"
  const cancel = link(working ? "Cancelling…" : "Cancel this invoice", () => void cancelInvoice())
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
  return screen({ title: `Pay with ${methodName(coin)}`, lead: "Bookmark this page to come back to this payment." },
    partial ? alertBox("warn", "alert", "Part of the payment arrived", partSentence(inv, coin)) : null,
    orderLine(s),
    insteadLine(inv),
    el("div", { class: "qr-grid" },
      uri ? el("div", { class: "card qr" }, qrSvg(uri, `${methodName(coin)} payment`), el("a", { href: uri }, "Open in wallet")) : null,
      // labels in sentence case, as their copy buttons say them; the label style draws them in capitals
      copyField(`${partial ? "rest to send" : "amount"} in ${TICKER[coin]}`, due),
      copyField(`${methodName(coin)} address`, inv.address!)),
    el("p", { class: "note waiting" }, el("span", {}, partial ? "Waiting for the rest of the payment" : "Waiting for payment", SEP, rateLine(inv, signal)),
      partial ? null : cancelLink(s)),
    // a wait the tab is in shows why the link does nothing until it is over
    actionNote(s, partial ? null : signal),
    referenceLine(inv.invoiceId))
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
  actionNote(state, null)
}

async function payByCard(): Promise<void> {
  if (state.busy || !card) return
  const gen = opened
  const { invoice, record } = state
  dispatch({ type: "card-started" })
  const confirmed = await card.confirm()
  if (!isOpen(gen)) return
  if (confirmed.kind === "error") return dispatch({ type: "card-refused", note: { tone: "danger", icon: "alert", title: null, text: confirmed.message } })
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
  payButton = setAction(btn(`Pay ${dollars(invoice.amount, true)}`, "block", () => void payByCard()), s.busy === "card", card === null)
  payButton.dataset.focus = "pay"
  // a submitted card is remembered only in storage; without it, a reload would offer the form again
  const forgetful = store.canPersist() ? null : alertBox("warn", "alert", "This browser cannot remember a card payment",
    "After paying, keep this page open until it moves on. Reloading would show the card form again.")
  return screen({ title: "Pay by card" }, orderLine(s), insteadLine(invoice), forgetful, form, actionNote(s, null), payButton)
}

function cardStandIn(form: HTMLElement): void {
  const f = (text: string, value: string) => el("label", { class: "f" }, el("span", {}, text), el("div", { class: "box" }, value))
  form.append(el("div", { class: "label" }, el("span", {}, "Stripe's payment form"), el("span", {}, "Development stand-in")),
    f("Card number", "4242 4242 4242 4242"), el("div", { class: "cols" }, f("Expiry", "12 / 30"), f("CVC", "123"), f("Country", "Portugal")))
}

// a new search from an order opened from the app stays the app's, so a name found there registers to its wallet
const searchFrom = (view: api.RegistrationView, record: store.OrderRecord | null) => searchLink("", openedFromApp(view, record) ? view.owner : null)

// what a browser without the order's record can do: take in the name code, or, for an app's order, nothing here
function withoutRecord(view: api.RegistrationView, cls: string, text = "Enter your name code"): HTMLButtonElement {
  return view.sealed === null ? btn("Search a name", cls, () => go(searchFrom(view, null))) : btn(text, cls, () => go("/#/restore"), icon("key"))
}

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

// an invoice that took a payment says how support gives it back
function closedWords(closed: ClosedCase, inv: api.InvoiceView): [Tone, Kid] {
  switch (closed) {
    case "paid-late": return ["warn", "The payment arrived after this invoice had closed, so nothing was registered. Support refunds it: quote the reference below."]
    case "still-open": return ["warn", `${cancelStillOpen(inv)}${partlyPaid(inv) ? " Part of the payment arrived; quote the reference below to support." : ""}`]
    case "cancelled": return ["info", "This invoice was cancelled and nothing was received."]
    case "received": {
      const coin = coinOf(inv)
      const arrived = coin && partlyPaid(inv) && !inv.paidInFull ? `${inv.cryptoAmountPaid} ${TICKER[coin]} arrived, which is not the full amount.` : "A payment did not complete before the invoice closed."
      return ["warn", [`${arrived} Write to `, el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), " with the reference below and we will sort it out."]]
    }
    case "expired": return ["info", inv.cryptoCurrency ? "Nothing was received before its rate window closed." : "Nothing was paid before it closed."]
  }
}

// a new invoice reuses this order's commitment, which only the browser holding its name code can rebuild
function closedAction(s: OrderState, closed: ClosedCase): HTMLButtonElement {
  const { view, record } = s
  if (record?.replacedBy) return btn("Open the new invoice", "quiet", () => go(record.replacedBy!))
  // a cancel the service still shows open takes no more payment, so nothing here pays it
  if (closed === "paid-late" || closed === "still-open") return btn("Search a name", "quiet", () => go(searchFrom(view!, record)))
  if (!record) return withoutRecord(view!, "quiet")
  if (closed === "cancelled") return btn("Order the name again", "", () => go(searchLink(record.label, record.ownerCode === null ? record.owner : null)), icon("arrow"))
  return newInvoiceButton(s, closed === "received" && !record.cancelled ? "quiet" : "", reorder)
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
    extra: actionNote(s, formFailed && s.record !== null ? signal : null), action: cardAction(s, formFailed) })
}

// Once the service has seen a card payment, entering the card again could charge twice.
function cardAction(s: OrderState, formFailed: boolean): HTMLButtonElement | null {
  if (formFailed) return s.record ? newInvoiceButton(s, "", () => void reorderAfterCancel()) : withoutRecord(s.view!, "")
  return s.invoice!.amountPaid ? null : btn("Enter the card again", "", enterCardAgain)
}

async function reorderAfterCancel(): Promise<void> {
  const gen = opened
  const invoice = state.invoice!
  dispatch({ type: "reorder-started" })
  if (await cancelBeforeReorder(invoice, gen)) return newInvoice(invoice, store.orderByInvoice(invoice.invoiceId), gen)
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
    if (after.status === "open") {
      say(cancelStillOpen(after))
      return false
    }
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
    // without a record nothing keeps the cancel, so the warning shows here once
    const stillOpen = !record && after.status === "open"
    answer(gen, { type: "cancel-answered", note: stillOpen ? { tone: "danger", icon: "alert", title: null, text: cancelStillOpen(after) } : null })
    if (!stillOpen) reread(gen)
  } catch (e) {
    // an invoice that closed meanwhile is shown as it is now
    if (e instanceof api.ApiError && e.code === "not_open") {
      answer(gen, { type: "cancel-answered", note: null })
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
  return screen({ title: coin ? "Confirming your payment" : "Paying by card" }, orderLine(s), notice, referenceLine(invoice.invoiceId))
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
  const { label, ownerCode, owner } = record!
  const appOwner = ownerCode === null ? owner : null
  return outcome({ tone: "warn", icon: "alert", title: "The price changed", text: [nameText(label, invoice!.registration.tld), ` costs ${dollars(price!, true)} now. Nothing was charged.`],
    action: btn("Search again", "", () => go(searchLink(label, appOwner))), reference: invoice!.invoiceId })
}

async function newInvoice(invoice: api.InvoiceView, record: store.OrderRecord | undefined, gen: number): Promise<void> {
  if (!isOpen(gen) || !record) return
  try {
    // the invoice as it is now: one still open, or paid into a registration, is the order; one paid after it closed
    // registered nothing, so the name is ordered again and support refunds the late payment
    const now = await api.readInvoice(invoice.invoiceId)
    if (now.status === "open" || (now.status === "paid" && now.registration.phase !== "unpaid")) {
      if (isOpen(gen)) go(store.invoiceUrl(invoice.invoiceId))
      return
    }
    const res = await api.createOrder(record.request, invoice.cryptoCurrency ?? "card", invoice.amount)
    const next = store.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id })
    // the old record is the stored owner code until the new one is stored too
    store.saveOrder({ ...record, registrationId: res.registration.id, invoiceId: res.invoiceId, ...flow.paidWith(res), cancelled: false, cardSubmittedAt: undefined, replacedBy: undefined, createdAt: new Date(api.serviceNow()).toISOString() })
    // Your names lists the old order only while money it received needs its reference; its page leads to the new one
    if (res.registration.id !== record.registrationId) store.updateOrder(record.registrationId, { replacedBy: next })
    if (isOpen(gen)) go(next)
  } catch (e) {
    if (!isOpen(gen)) {
      holdFrom(e)
      return
    }
    const appOwner = record.ownerCode === null ? record.owner : null
    if (e instanceof api.ApiError && e.code === "name_taken") return go(searchLink(record.label, appOwner))
    if (e instanceof api.ApiError && typeof e.body.invoiceId === "string") return go(store.invoiceUrl(e.body.invoiceId))
    if (e instanceof api.ApiError && e.code === "catalog_changed" && typeof e.body.price === "number") return dispatch({ type: "price-changed", price: e.body.price })
    if (e instanceof api.ApiError && e.code === "provider_unavailable") {
      return dispatch({ type: "reorder-failed", note: { tone: "warn", icon: "alert", title: `${methodName(invoice.cryptoCurrency ?? "card")} is unavailable right now`,
        text: "Nothing was charged. Try again later, or ", link: { text: "order the name again", href: searchLink(record.label, appOwner), after: " to pay another way." } } })
    }
    if (holdOn(e, "Nothing was charged. ", gen)) return
    dispatch({ type: "reorder-failed", note: { tone: "warn", icon: "alert", title: "That did not go through", text: "Nothing was charged. Try again in a moment." } })
  }
}

type StageState = "done" | "active" | "failed" | ""
const STAGES = [
  { n: "1", going: "Committing", done: "Committed" },
  { n: "2", going: "Waiting", done: "Waiting" },
  { n: "3", going: "Registering", done: "Registered" },
]

function stages(states: StageState[]): HTMLElement {
  return el("ol", { class: "stages", role: "list" }, ...STAGES.map((stage, i) => el("li", { class: `stage ${states[i]}`.trim() },
    el("span", { class: "node" }, states[i] === "done" ? "✓" : states[i] === "failed" ? "✕" : stage.n),
    el("b", {}, states[i] === "done" ? stage.done : stage.going))))
}

const stagesOf = (view: api.RegistrationView): StageState[] => view.phase === "registering" ? ["done", "done", "active"] : view.phase === "committed" ? ["done", "active", ""] : ["active", "", ""]

function headingOf({ view, record }: OrderState): Kid {
  const label = labelOf(view!, record)
  return label ? ["Registering ", gradName(label, view!.tld)] : "Registering the name"
}

const leadOf = ({ view, record }: OrderState) => openedFromApp(view!, record) ? "Keep this page open while SimpleX finishes it."
  : record ? "Keep this page open until the name is yours." : "The browser with its name code signed it."

const WAIT_NOTE = "Every new name waits a little, so nobody who sees your order can take the name first."
const COMMIT_NOTE = "Placing your order. The wait starts once it is in."
const REGISTERING_NOTE = "Registering the name. It is yours in a moment."

function buildRegistering(s: OrderState, signal: AbortSignal): HTMLElement {
  const { record } = s
  const view = s.view!
  const states = stagesOf(view)
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
    if (openedFromApp(view, record) && view.label === null) say(note, "Waiting for SimpleX to sign the registration with your app's wallet.")
    else if (view.label === null && refused) say(note, "The registration is not signed yet.")
    else say(note, REGISTERING_NOTE)
  }
  onTheSecond(() => waitLeft(view), tick, signal)
  return screen({ title: headingOf(s), lead: leadOf(s) },
    steps,
    // the note keeps the height of its longest words, so the page keeps still as they change
    el("div", { class: "countdown" }, clockNode, el("p", {}, note, el("span", { class: "sizer", "aria-hidden": "true" }, WAIT_NOTE))),
    refused ? alertBox("danger", "alert", "The name could not be signed", "The service refused the signed registration.") : null,
    refused ? btn("Try again", "quiet block", tryAgain, icon("refresh")) : null,
    referenceLine(s.invoice?.invoiceId ?? view.id))
}

const waitsSeen = new Map<string, number>()
const waitLeft = (view: api.RegistrationView) => (view.revealAfter ?? 0) - api.serviceNow() / 1000
function fillWait(stage: HTMLElement, view: api.RegistrationView): void {
  const now = api.serviceNow()
  const end = (view.revealAfter ?? 0) * 1000
  if (!waitsSeen.has(view.id)) waitsSeen.set(view.id, now)
  const start = waitsSeen.get(view.id)!
  const done = end > start ? Math.min(1, (now - start) / (end - start)) : 1
  stage.style.setProperty("--done", String(done))
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

function buildNotOnDevice({ view, invoice }: OrderState): HTMLElement {
  return outcome({ tone: "info", icon: "key", title: "The name code is not in this browser",
    text: ["This order registers a name to ", el("span", { class: "nowrap" }, shortAddress(view!.owner)), ". Its code was made in the browser it was bought in. Enter the code you saved to carry on here."],
    action: btn("Enter your name code", "", () => go("/#/restore"), icon("arrow")), reference: invoice?.invoiceId ?? view!.id })
}

function registeredActions(view: api.RegistrationView, record: store.OrderRecord | null): HTMLElement {
  if (!record) return withoutRecord(view, "quiet block", "Restore with your name code")
  const names = el("a", { class: record.ownerCode ? "btn" : "btn quiet", href: "/#/names" }, "Your names")
  return el("div", { class: "actions pair" }, record.ownerCode
    ? [names, el("a", { class: "btn quiet", href: `/#/edit/${view.id}` }, icon("link"), "Edit links")]
    : [btn("Back to SimpleX", "", () => { location.href = "simplex:/" }), names])
}

function buildRegistered(s: OrderState): HTMLElement {
  const view = s.view!
  const label = labelOf(view, s.record)
  const code = s.record?.ownerCode ?? null
  return screen({ title: [label ? gradName(label, view.tld) : "The name", " is\u00a0yours"], lead: registeredLead(view, s.record) },
    code ? el("div", { class: "card next-step qr-grid" }, el("div", { class: "qr" }, qrSvg(code, "name code")),
      el("div", {}, el("h2", {}, "Redeem it in the app"), el("p", { class: "note" }, "Scan or enter the code in SimpleX: the name moves to the app's wallet.")),
      codeDisplay(code, "owner-code")) : null,
    registeredActions(view, s.record))
}

function registeredLead(view: api.RegistrationView, record: store.OrderRecord | null): string {
  const until = view.expiresAt ? dateOf(view.expiresAt) : ""
  if (record?.ownerCode) return `Registered until ${until}.`
  if (record) return `Registered for ${termText(view.years)}, until ${until}, to your app's wallet, ${shortAddress(view.owner)}.`
  return view.sealed === null ? `Registered until ${until} to the wallet of the app it was ordered from, ${shortAddress(view.owner)}.`
    : `Registered until ${until} to ${shortAddress(view.owner)}. Its name code is not in this browser.`
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
  const worth = dollars(view.price, true)
  const canAct = Boolean(record?.ownerCode)
  const fromApp = openedFromApp(view, record)
  const other = setAction(btn("Choose another name", "block", () => go(`/#/?retarget=${view.id}`)), false, !canAct)
  const code = setAction(btn("Take a code", "quiet block", () => void takeCode()), canAct && s.busy === "code", !canAct || s.hold !== null)
  code.dataset.focus = "take-code"
  holdEnds(signal)(s.hold !== null)
  const cannot = canAct ? null : fromApp
    ? alertBox("info", "phone", "This order was opened from SimpleX", "Choose another name or take a code in the app.")
    : alertBox("info", "key", "The name code is not in this browser", "Restore it in Your names to choose another name or take a code.")
  return screen({ title: "Someone registered it first", lead: [label ? nameText(label, view.tld) : "The name", " was registered just before ours. Your payment is kept."] },
    orderLine(s),
    stages(["done", "done", "failed"]),
    el("p", { class: "note" }, `Choose another name of up to ${worth}, registered to the same wallet so your code owns it, or take a code for names of ${codeTier(label?.length ?? LONGEST_TIER)} or more letters, for ${termText(PRICED_YEARS)}.`),
    cannot,
    el("div", { class: "actions" }, other, code),
    actionNote(s, canAct ? signal : null),
    referenceLine(invoice.invoiceId))
}

async function takeCode(): Promise<void> {
  const gen = opened
  const view = state.view!
  const record = state.record!
  dispatch({ type: "code-started" })
  try {
    await flow.takeCodeFor(record, view)
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
  if (openedFromApp(view, record)) {
    return outcome({ tone: "info", icon: "key", title: "This order became a code", text: "The app the order was opened from shows the code.",
      action: btn("Search a name", "", () => go(searchFrom(view, record))), reference: view.id })
  }
  if (!record?.ownerCode) {
    return outcome({ tone: "info", icon: "key", title: "This order became a code",
      text: "The code is made from the order's name code, so it shows in the browser that has it. Restore the name code here to see it.",
      action: btn("Enter your name code", "", () => go("/#/restore"), icon("arrow")), reference: view.id })
  }
  const code = record.takenCode ?? flow.takenCodeOf(record, view.id)
  return outcome({ tone: "ok", icon: "key", title: "Here is a code instead",
    text: [`For names of ${codeTier(record.label.length)} or more letters, for ${termText(PRICED_YEARS)}: what `, nameText(record.label, view.tld), " was paid for."],
    action: btn("Search another name", "quiet", () => go("/#/")),
    extra: [codeDisplay(code),
      el("div", { class: "center mt-16" }, el("div", { class: "qr" }, qrSvg(code, "code"))),
      el("div", { class: "left" }, alertBox("info", "info", "Keep a copy of this code", "The service keeps only its hash; this browser keeps the code, under Your names."))] })
}

function buildFailed(s: OrderState, signal: AbortSignal): HTMLElement {
  const { view: failed, record, invoice } = s
  const view = failed!
  // a code refused for good leaves nothing to try again, so the page offers another search as the other endings do
  const retry = setAction(btn("Try again", "", () => void retryRegistration(), icon("refresh")), s.busy === "retry", s.hold !== null)
  retry.dataset.focus = "retry"
  const action = s.codeRefused ? btn("Search a name", "quiet", () => go(searchFrom(view, record))) : retry
  holdEnds(signal)(s.hold !== null)
  const failedAt: StageState[] = view.commitTx === null ? ["failed", "", ""] : ["done", "done", "failed"]
  return screen({ title: invoice ? "Paid, not registered" : "Not registered", lead: failedLead(s) },
    orderLine(s),
    stages(failedAt),
    alertBox("danger", "alert", view.error ?? "The registration did not go through", "The service's own retries gave up."),
    actionNote(s, signal),
    action,
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
// A code the service no longer knows (code_invalid) was revoked, not spent; null when the service did not answer.
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
