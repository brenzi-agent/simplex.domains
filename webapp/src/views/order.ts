// An order's page (?order=<invoice>) or a code registration's (?registration=<id>): payment, registration, and every ending.
import * as api from "../api.ts"
import { codeTier, LONGEST_TIER, parseNameCode } from "../crypto/code.ts"
import { alertBox, btn, chip, codeDisplay, copyButton, disabled, el, gradName, icon, link, liveRegion, nameText, nameTitle } from "../dom.ts"
import * as flow from "../flow.ts"
import * as focus from "../focus.ts"
import { current, live, rollTo, takeTurns } from "../motion.ts"
import { clock, dateOf, dollars, methodName, shortAddress, shortHash, termText } from "../format.ts"
import { paymentUri, qrSvg } from "../qr.ts"
import { headingFocus, step } from "../screens/machine.ts"
import {
  coinOf, initialState, type Note, openedFromApp, orderMachine, type OrderEvent, type OrderKind, type OrderState, refusalsOf,
  retryRefusal, REVEAL_ATTEMPTS, revealDue, revealKey, wakeAt,
} from "../screens/order.ts"
import * as store from "../store.ts"
import { mountCard, publishableKey } from "../stripe.ts"
import { useCode } from "./codes.ts"
import { every } from "./effects.ts"
import { holdEnd, holdEnder, holdFrom, tabHold } from "./hold.ts"
import { changeTo, drawAs, holdNotice, setAction, unchanging } from "./slots.ts"
import { type Build, type Built, CONTACT_EMAIL, crumbs, crumbsTo, currentRoute, go, isDark, isRedraw, isRoute, pageHead, placeholderSoon, redirect, refresh, screens, searchLink, status, twoCols, whenLeaving } from "./shell.ts"

const RETRY_MS = 3000
// The badge service's words for a cancel the provider took while the service still shows the invoice open; a card
// invoice has no address. The browser keeps the cancel, so the warning stays until the invoice closes.
const cancelStillOpen = (invoice: api.InvoiceView) => invoice.cryptoCurrency
  ? "This invoice was cancelled, but the service still shows it open. Do not send anything more to the address."
  : "This invoice was cancelled, but the service still shows it open. Do not pay it again."

// the count stays with its word on one line; a payment taken on first sight waits for no confirmation at all
const confirmations = (n: number) => (n === 1 ? "Waiting for 1\u00a0confirmation" : n > 1 ? `Waiting for ${n}\u00a0confirmations` : "Waiting for the payment to settle")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const warning = (text: string): Note => ({ tone: "warn", icon: "alert", title: null, text })

let state: OrderState = initialState("", null)
let shown: OrderKind | null = null
const showScreen = screens<OrderState>()
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
    shown = null
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
  // the same order drawn again stays on screen until it is read, rather than blanking to a loading line
  if (redraw) document.querySelector("main")?.setAttribute("aria-busy", "true")
  else placeholderSoon()
  void follow(mine, invoiceId, registrationId, polls.signal)
}

function dispatch(event: OrderEvent): void {
  const before = state
  const result = step(orderMachine, state, shown, event)
  state = result.state
  if (!isRoute(pageRoute)) return
  const heading = headingFocus(result, shown, focus.onPage())
  const arrived = result.screen !== shown
  shown = result.screen
  document.querySelector("main")?.removeAttribute("aria-busy")
  showScreen(result.screen, state, BUILDS[result.screen], heading, result.motion)
  if (revealDue(state)) reveal(state.view!, state.record!)
  if (arrived || state.record !== before.record) keepCodes(state)
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

function keepCodes({ view, record, invoice, cardSubmittedAt: submitted }: OrderState): void {
  if (!view || !record) return
  if (shown === "code-issued" && record.ownerCode && !record.takenCode) {
    const code = flow.takenCodeOf(record, view.id)
    store.updateOrder(record.registrationId, { takenCode: code })
    store.addCode({ code, minLength: codeTier(record.label.length), years: 2, addedAt: new Date().toISOString() })
    dispatch({ type: "record-changed", record: { ...record, takenCode: code }, cardSubmittedAt: submitted })
  }
  const released = shown === "taken" && !invoice ? releasedCode(view, record) : null
  if (released && !store.codes().some((c) => c.code === released.code)) store.addCode({ ...released, addedAt: new Date().toISOString() })
}

function releasedCode(view: api.RegistrationView, record: store.OrderRecord | null): Omit<store.CodeRecord, "addedAt"> | null {
  const code = record?.prepaidCode
  if (!code) return null
  const parsed = parseNameCode(code)
  const minLength = parsed?.kind === "prepaid" ? parsed.minLength : codeTier(labelOf(view, record)?.length ?? LONGEST_TIER)
  return { code, minLength, years: view.years }
}

const actionRow = () => live(el("div", { class: "actions" }))

function noteNode(note: Note, cls: string): HTMLElement {
  const text = note.link ? [note.text, el("a", { href: note.link.href }, note.link.text), note.link.after] : note.text
  return el("div", { class: cls }, alertBox(note.tone, note.icon, note.title, text))
}

function showNote(slot: HTMLElement, s: OrderState, cls: string, holds: boolean): void {
  const hold = holds ? s.hold : null
  drawAs(slot, JSON.stringify([hold, s.note]), () => hold ? [holdNotice(hold)] : s.note ? [noteNode(s.note, cls)] : [])
}

function buildUnreadable({ reference }: OrderState): Built<OrderState> {
  return unchanging([status("warn", "alert", "This order could not be loaded", "The page keeps trying. If it does not load, quote the reference below.", [], { reference })])
}

function buildUnknownLink(): Built<OrderState> {
  return unchanging([status("info", "link", "This link does not work", "It names no order this service knows. Check the link, or start again.", [btn("Search a name", "", () => go("/#/"))])])
}

function buildPaidLate(paid: OrderState): Built<OrderState> {
  const actions = actionRow()
  const update = ({ view, record }: OrderState) => drawAs(actions, record?.replacedBy ?? "", () =>
    [record?.replacedBy ? btn("Open the new invoice", "quiet", () => go(record.replacedBy!)) : btn("Search a name", "quiet", () => go(searchFrom(view!, record)))])
  update(paid)
  return { sections: [status("warn", "alert", "Paid after the invoice closed", "The payment arrived after this invoice had closed, so nothing was registered. Support refunds it: quote the reference below.",
    [], { reference: paid.invoice!.invoiceId, extra: actions })], update }
}

function buildPaidByInvoice(unpaid: OrderState): Built<OrderState> {
  const actions = actionRow()
  const update = ({ view, record }: OrderState) => drawAs(actions, record?.invoiceId ?? "", () =>
    [record?.invoiceId ? btn("Open its payment", "", () => go(store.orderUrl(record))) : btn("Search a name", "quiet", () => go(searchFrom(view!, record)))])
  update(unpaid)
  return { sections: [status("info", "link", "This order is paid by invoice", "Its page is the payment link it was made with.", [], { reference: unpaid.view!.id, extra: actions })], update }
}

const shortRef = (reference: string) => el("span", { class: "mono" }, `${reference.slice(0, 8)}…`)
// in full where the page leads to support, which asks for it
const fullRef = (reference: string) => el("span", { class: "mono ref-full" }, reference)

function orderCard(name: Node, rows: [string, string | Node][], ...rest: (Node | null)[]): HTMLElement {
  return el("aside", { class: "panel summary" },
    el("span", { class: "label" }, "Your order"),
    name,
    el("div", { class: "rows" }, ...rows.map(([k, v]) => el("div", { class: "r" }, el("span", {}, k), typeof v === "string" ? el("span", {}, v) : v))),
    ...rest)
}

// a browser without the order's record learns the name only once it is revealed on chain
const labelOf = (view: api.RegistrationView, record: store.OrderRecord | null) => view.label ?? record?.label ?? null
const cardName = (label: string | null, tld: string) => label ? nameTitle(label, "nm order-name", tld) : el("div", { class: "nm unknown" }, "The name shows once it is registered")
const total = (amount: number) => el("div", { class: "total" }, el("span", { class: "label" }, "Total"), el("b", {}, dollars(amount, true)))

// what is copied can differ from what is shown, as an amount without its unit, which a wallet's amount field refuses
function copyField(label: string): { node: HTMLElement; set: (value: string, copy?: string | false) => void } {
  const box = live(el("div", {}))
  const set = (value: string, copy: string | false = value) => {
    const button = copy === false ? null : copyButton(copy, null, "field-copy", `Copy ${label.toLowerCase()}`)
    // A value of one long word, as an address, may break between any two letters, which the field's balance evens out:
    // WebKit balances only between the breaks it is given, Firefox only in a word that breaks anywhere (.word).
    const word = !value.includes(" ")
    const shown = word ? [...value].flatMap((ch, i) => i ? [el("wbr"), ch] : [ch]) : [value]
    changeTo(box, el("div", { class: "val" }, el("span", { class: word ? "word" : undefined }, ...shown), button))
  }
  return { node: el("div", { class: "copy-field" }, el("span", { class: "label" }, label), box), set }
}

function countdown(node: HTMLElement, prefix: string, end: () => number, signal: AbortSignal): () => void {
  const time = el("span", { class: "time" })
  node.replaceChildren(`${prefix} `, time)
  const turn = () => rollTo(time, clock((end() - api.serviceNow()) / 1000), true)
  turn()
  every(1000, turn, signal)
  return turn
}

function buildPayCrypto(state: OrderState, signal: AbortSignal): Built<OrderState> {
  let shown = state
  const { view, record } = state
  const invoice = state.invoice!
  const currency = coinOf(invoice)!
  const coin = currency === "btc" ? "BTC" : "XMR"
  const name = methodName(currency)
  const partialOf = (inv: api.InvoiceView) => Number(inv.cryptoAmountPaid ?? "0") > 0
  const alert = live(el("div", {}))
  const sendLabel = live(el("span", { class: "label" }))
  const amount = live(el("div", { class: "amount" }))
  const usd = live(el("div", { class: "usd" }))
  const rate = chip("", "brand")
  const turnRate = countdown(rate, "Rate held", () => Date.parse(shown.invoice!.expiresAt), signal)
  const qr = live(el("div", { class: "qr" }))
  let qrUri: string | null | undefined
  const [amountField, addressField, referenceField] = [copyField("Amount"), copyField(`${name} address`), copyField("Reference")]
  const awaiting = live(el("span", {}))
  const cancelSlot = live(el("span", {}))
  const named = live(el("div", {}))
  const note = liveRegion()
  const watchHold = holdEnds(signal)
  const [idleLabel, busyLabel] = [el("span", {}, "Cancel this invoice"), el("span", { "aria-hidden": "true" }, "Cancelling…")]
  const cancel = link(el("span", { class: "swap" }, idleLabel, busyLabel), () => void cancelInvoice())
  // aria-hidden as "true", which assistive technology and the stylesheet both read; an empty one counts as not hidden
  const showWorking = (on: boolean) => {
    const [shownLabel, hidden] = on ? [busyLabel, idleLabel] : [idleLabel, busyLabel]
    if (hidden.getAttribute("aria-hidden") !== "true") takeTurns(shownLabel, hidden)
    shownLabel.removeAttribute("aria-hidden")
    hidden.setAttribute("aria-hidden", "true")
    if (on) cancel.setAttribute("aria-disabled", "true")
    else cancel.removeAttribute("aria-disabled")
  }
  const show = (next: OrderState) => {
    const inv = next.invoice!
    const partial = partialOf(inv)
    const due = partial ? inv.cryptoAmountDue! : inv.cryptoAmount!
    changeTo(alert, ...(partial ? [el("div", { class: "mb-18" }, alertBox("warn", "alert", "Part of the payment arrived", `${inv.cryptoAmountPaid} of ${inv.cryptoAmount} ${coin} is seen. Send the remaining ${due} ${coin} to the same address.`))] : []))
    changeTo(sendLabel, partial ? "Send the rest" : "Send")
    changeTo(amount, `${due} ${coin}`)
    changeTo(usd, `${dollars(inv.amount, true)} in total`)
    const uri = paymentUri(currency, inv.address!, due)
    if (uri !== qrUri) {
      qrUri = uri
      const code = uri ? qrSvg(uri, `${name} payment`) : null
      qr.replaceChildren(...(code ? [code] : []))
    }
    amountField.set(`${due} ${coin}`, due)
    addressField.set(inv.address!)
    referenceField.set(inv.invoiceId, false)
    changeTo(awaiting, partial ? "Waiting for the rest of the payment" : "Waiting for payment")
    changeTo(cancelSlot, ...(partial ? [] : [cancel]))
    changeTo(named, cardName(labelOf(next.view!, next.record), next.view!.tld))
    showWorking(next.busy === "cancel")
    // a wait the tab is in shows why the link does nothing until it is over
    showNote(note, next, "mt-14", !partial)
    watchHold(next.hold !== null)
  }
  show(state)
  const main = el("div", { class: "panel" }, el("div", { class: "panel-sec" },
    alert,
    el("div", { class: "pay-head" }, el("div", {}, sendLabel, amount, usd), rate),
    el("div", { class: "pay-body" }, qr, el("div", {}, amountField.node, addressField.node, referenceField.node)),
    el("div", { class: "waiting" }, el("span", { class: "awaiting" }, awaiting), cancelSlot), note))
  const update = (next: OrderState) => {
    const newRate = next.invoice!.expiresAt !== shown.invoice!.expiresAt
    shown = next
    show(next)
    if (newRate) turnRate()
  }
  return { sections: [pageHead(`Pay with ${name}`, "Bookmark this page: the address and the countdown live on its link.", crumbs("Payment", { fromApp: openedFromApp(view!, record) })),
    twoCols(main, orderCard(named, [["Term", termText(view!.years)], ["Paying with", name]], total(invoice.amount)))], update }
}

function buildPayCard(paying: OrderState, signal: AbortSignal): Built<OrderState> {
  const { view, record } = paying
  const invoice = paying.invoice!
  const pay = btn(`Pay ${dollars(invoice.amount, true)}`, "block")
  const error = el("div", {})
  const form = el("div", { class: "stripe" })
  // a submitted card is remembered only in storage; without it, a reload would offer the form again
  const forgetful = store.canPersist() ? null : el("div", { class: "mb-14" }, alertBox("warn", "alert", "This browser cannot remember a card payment",
    "After paying, keep this page open until it moves on. Reloading would show the card form again."))
  const main = el("div", { class: "panel" }, el("div", { class: "panel-sec" },
    el("div", { class: "sec-title" }, el("h2", {}, "Card details")), forgetful, form, error, el("div", { class: "mt-18" }, pay)))
  // The page knows the card was submitted without asking the service, so it shows that at once, in an outage too; only
  // while this form is still on screen, since a confirm can outlast the screen.
  const submitted = () => {
    const at = new Date(api.serviceNow()).toISOString()
    store.markCardSubmitted(invoice.invoiceId, at)
    if (record) store.updateOrder(record.registrationId, { cardSubmittedAt: at })
    if (!signal.aborted) dispatch({ type: "card-submitted", at })
  }
  let ready = false
  const mount = async (key: string) => {
    disabled(pay)
    const card = await mountCard(key, invoice.clientSecret ?? "", form, isDark())
    if (signal.aborted || !form.isConnected) return card?.destroy()
    if (!card) return dispatch({ type: "card-failed" })
    signal.addEventListener("abort", () => card.destroy(), { once: true })
    ready = true
    pay.removeAttribute("disabled")
    pay.addEventListener("click", async () => {
      if (state.busy) return
      dispatch({ type: "card-started" })
      const outcome = await card.confirm()
      if (outcome.kind === "submitted") return submitted()
      if (!signal.aborted) dispatch({ type: "card-refused", note: { tone: "danger", icon: "alert", title: null, text: outcome.message } })
    })
  }
  const key = publishableKey()
  if (!key && import.meta.env.DEV) cardStandIn(form, pay, submitted)
  else queueMicrotask(() => void mount(key))
  return { sections: [pageHead("Pay by card", null, crumbs("Payment", { fromApp: openedFromApp(view!, record) })),
    twoCols(main, orderCard(cardName(labelOf(view!, record), view!.tld), [["Term", termText(view!.years)], ["Paying with", "Card"]], total(invoice.amount)))],
  update: (next) => {
    if (ready) setAction(pay, next.busy === "card", false)
    showNote(error, next, "mt-14", false)
  } }
}

// Without a Stripe key in development, Pay does what a submitted card does; the mock's controls settle it.
function cardStandIn(form: HTMLElement, pay: HTMLButtonElement, submitted: () => void): void {
  const f = (text: string, value: string) => el("label", { class: "f" }, el("span", {}, text), el("div", { class: "box" }, value))
  form.append(el("div", { class: "label" }, el("span", {}, "Stripe's payment form"), el("span", {}, "Development stand-in")),
    f("Card number", "4242 4242 4242 4242"), el("div", { class: "two" }, f("Expiry", "12 / 30"), f("CVC", "123")), f("Country", "Portugal"))
  pay.addEventListener("click", submitted)
}

// a new search from an order opened from the app stays the app's, so a name found there registers to its wallet
const searchFrom = (view: api.RegistrationView, record: store.OrderRecord | null) => searchLink("", openedFromApp(view, record) ? view.owner : null)

// what a browser without the order's record can do: take in the name code, or, for an app's order, nothing here
function withoutRecord(view: api.RegistrationView, cls: string, text = "Enter your name code"): HTMLButtonElement {
  return view.sealed === null ? btn("Search a name", cls, () => go(searchFrom(view, null))) : btn(text, cls, () => go("/#/restore"), icon("key"))
}

// A cancel the service still shows open: nothing more is paid into the invoice, so the page offers no way to pay it.
// The page keeps following it, and shows it as cancelled once the service closes it.
const partlyPaid = (invoice: api.InvoiceView) => Number(invoice.cryptoAmountPaid ?? "0") > 0
function buildStillOpen(cancelled: OrderState): Built<OrderState> {
  const inv = cancelled.invoice!
  const words = live(el("span", {}))
  const update = ({ invoice }: OrderState) => changeTo(words, `${cancelStillOpen(invoice!)}${partlyPaid(invoice!) ? " Part of the payment arrived; quote the reference below to support." : ""}`)
  update(cancelled)
  return { sections: [status("warn", "alert", "Invoice cancelled", words,
    [btn("Search a name", "quiet", () => go(searchFrom(inv.registration, state.record)))], { reference: inv.invoiceId })], update }
}

function buildCardFailed(s: OrderState, signal: AbortSignal): Built<OrderState> {
  const inv = s.invoice!
  const note = liveRegion()
  const watchHold = holdEnds(signal)
  const actions = live(el("div", { class: "actions" }))
  const load = btn("Load the card form again", "", () => dispatch({ type: "card-retried" }))
  const again = btn("Get a new invoice", "quiet", () => void reorderAfterCancel())
  const update = (next: OrderState) => {
    drawAs(actions, next.record ? "again" : "", () => [load, next.record ? again : withoutRecord(next.view!, "quiet")])
    setAction(again, next.busy === "reorder", next.hold !== null)
    showNote(note, next, "left mt-18", next.record !== null)
    watchHold(next.hold !== null)
  }
  update(s)
  return { sections: [status("warn", "alert", "The card form did not load", "Stripe's form was blocked or failed to load. Nothing was charged.",
    [], { reference: inv.invoiceId, extra: [note, actions] })], update }
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

function buildConfirming(state: OrderState): Built<OrderState> {
  const { view, record } = state
  const invoice = state.invoice!
  const card = coinOf(invoice) === null
  const line = live(el("div", { class: "amount smaller" }))
  const named = live(el("div", {}))
  const show = (next: OrderState) => {
    changeTo(line, card ? "Waiting for Stripe to\u00a0confirm" : confirmations(next.invoice!.requiredConfirmations ?? 1))
    changeTo(named, cardName(labelOf(next.view!, next.record), next.view!.tld))
  }
  show(state)
  const coin = invoice.cryptoCurrency === "xmr" ? "XMR" : "BTC"
  const main = el("div", { class: "panel" }, el("div", { class: "panel-sec" },
    el("div", { class: "pay-head" }, el("div", {}, el("span", { class: "label" }, card ? "Card accepted" : "Payment received"), line)),
    el("p", { class: "sec-note mt-12" }, card
      ? "Stripe usually confirms within a minute. Registration starts by itself; this page moves on."
      : `${invoice.cryptoAmount} ${coin} arrived. Registration starts once it confirms; this page moves on by itself.`),
    el("div", { class: "meter" }, el("i")),
    el("div", { class: "waiting" }, el("span", { class: "awaiting" }, "Confirming payment"), el("span", { class: "mono ref-small" }, invoice.invoiceId))))
  return { sections: [pageHead(card ? "Paying by card" : "Confirming your payment", null, crumbs("Payment", { fromApp: openedFromApp(view!, record) })),
    twoCols(main, orderCard(named, [["Term", termText(view!.years)], ["Paying with", card ? "Card" : methodName(invoice.cryptoCurrency ?? "btc")]], total(invoice.amount)))], update: show }
}

// A card refused after Stripe's first answer leaves the invoice open with nothing paid; once the service has seen the payment, entering it again could charge twice.
function buildSlow(waiting: OrderState): Built<OrderState> {
  const actions = actionRow()
  const check = btn("Check again", "", refresh)
  const again = btn("Enter the card again", "quiet", enterCardAgain)
  const update = ({ invoice }: OrderState) => drawAs(actions, String(Boolean(invoice!.amountPaid)), () => invoice!.amountPaid ? [check] : [check, again])
  update(waiting)
  return { sections: [status("warn", "clock", "This is taking longer than expected", "The payment has not been confirmed. This page keeps working: come back to it later, or quote the reference below.",
    [], { reference: waiting.invoice!.invoiceId, extra: actions })], update }
}

function enterCardAgain(): void {
  const { invoice, record } = state
  store.clearCardSubmitted(invoice!.invoiceId)
  if (record) store.updateOrder(record.registrationId, { cardSubmittedAt: undefined })
  dispatch({ type: "record-changed", record: record && { ...record, cardSubmittedAt: undefined }, cardSubmittedAt: null })
}

function buildExpired(s: OrderState, signal: AbortSignal): Built<OrderState> {
  const inv = s.invoice!
  const note = liveRegion()
  // a new invoice reuses this order's commitment, which only the browser holding its name code can rebuild
  const received = api.holdsPayment(inv)
  if (s.record?.cancelled && !received) {
    const { label, ownerCode, owner } = s.record
    const restart = btn("Order the name again", "", () => go(searchLink(label, ownerCode === null ? owner : null)), icon("arrow"))
    return unchanging([status("info", "x", "Invoice cancelled", "This invoice was cancelled and nothing was received.", [restart], { reference: inv.invoiceId, extra: note })])
  }
  const words = live(el("span", {}))
  const actions = live(el("div", { class: "actions" }))
  const again = btn("Get a new invoice", "", reorder)
  const watchHold = holdEnds(signal)
  const update = (next: OrderState) => {
    const record = next.record
    const latest = next.invoice!
    if (received) {
      const coin = latest.cryptoCurrency === "xmr" ? "XMR" : "BTC"
      const arrived = partlyPaid(latest) && !latest.paidInFull ? `${latest.cryptoAmountPaid} ${coin} arrived, which is not the full amount.` : "A payment did not complete before the invoice closed."
      changeTo(words, `${arrived} Write to `, el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), " with the reference below and we will sort it out.")
    }
    drawAs(actions, record?.replacedBy ?? (record ? "again" : ""), () => [record?.replacedBy
      ? btn("Open the new invoice", "quiet", () => go(record.replacedBy!))
      : record ? again : withoutRecord(latest.registration, "quiet")])
    again.classList.toggle("quiet", received && !record?.cancelled)
    setAction(again, next.busy === "reorder", next.hold !== null)
    showNote(note, next, "left mt-18", record !== null && !record.replacedBy)
    watchHold(next.hold !== null)
  }
  update(s)
  const extra = { reference: inv.invoiceId, extra: [note, actions] }
  if (received) return { sections: [status("warn", "alert", "Invoice expired", words, [], extra)], update }
  return { sections: [status("info", "clock", "Invoice expired", inv.cryptoCurrency ? "Nothing was received before its rate window closed." : "Nothing was paid before it closed.", [], extra)], update }
}

function reorder(): void {
  const gen = opened
  const { invoice, record } = state
  dispatch({ type: "reorder-started" })
  void newInvoice(invoice!, record ?? undefined, gen)
}

function buildPriceChanged({ record, invoice, price }: OrderState): Built<OrderState> {
  const { label, ownerCode, owner } = record!
  const appOwner = ownerCode === null ? owner : null
  return unchanging([status("warn", "alert", "The price changed", [nameText(label, invoice!.registration.tld), ` costs ${dollars(price!, true)} now. Nothing was charged.`],
    [btn("Search again", "", () => go(searchLink(label, appOwner)))], { reference: invoice!.invoiceId })])
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
  { n: "1", going: "Committing", done: "Committed", text: "The name, hidden, goes on\u00a0chain" },
  { n: "2", going: "Waiting", done: "Waiting", text: "Every registration waits after its commit" },
  { n: "3", going: "Registering", done: "Registered", text: "Then it is yours" },
]

function track(states: StageState[]): { node: HTMLElement; set: (states: StageState[]) => void } {
  const parts = STAGES.map((s) => {
    const node = live(el("span", { class: "node" }))
    const title = live(el("b", {}))
    return { ...s, node, title, stage: el("div", { class: "stage" }, node, title, el("span", {}, s.text)) }
  })
  const set = (next: StageState[]) => parts.forEach((p, i) => {
    p.stage.className = `stage ${next[i]}`.trim()
    changeTo(p.node, next[i] === "done" ? "✓" : next[i] === "failed" ? "✕" : p.n)
    changeTo(p.title, next[i] === "done" ? p.done : p.going)
  })
  set(states)
  return { node: el("div", { class: "track" }, ...parts.map((p) => p.stage)), set }
}

// block explorers by chain id; a chain without one, as a local test chain, shows its hashes as text
const EXPLORERS: Record<number, string> = { 1: "https://etherscan.io", 11155111: "https://sepolia.etherscan.io" }

function onChain(view: api.RegistrationView, kind: "tx" | "address", value: string | null, text: string): HTMLElement {
  const explorer = EXPLORERS[view.chainId]
  return explorer && value
    ? el("a", { href: `${explorer}/${kind}/${value}`, target: "_blank", rel: "noopener", title: value }, `${text}\u00a0↗`)
    : el("span", { title: value ?? "" }, text)
}

type SetTxs = (view: api.RegistrationView, states: StageState[], refused: boolean, now: number) => void
function txRows(view: api.RegistrationView, states: StageState[], now: number, refused = false): { node: HTMLElement; set: SetTxs } {
  const tx = (k: string, ...cells: Node[]) => el("div", { class: "tx" }, el("span", { class: "k" }, k), ...cells)
  const [commitHash, commitChip, registerHash, registerChip] = [live(el("span", { class: "v mono" })), live(el("span", {})), live(el("span", { class: "v mono" })), live(el("span", {}))]
  const set: SetTxs = (view, states, refused, now) => {
    const hash = (h: string | null) => onChain(view, "tx", h, h ? shortHash(h) : "—")
    changeTo(commitHash, hash(view.commitTx))
    changeTo(commitChip, ...(view.commitTx ? [chip(states[0] === "done" ? "Confirmed" : "Sent", states[0] === "done" ? "ok" : "brand")] : []))
    changeTo(registerHash, hash(view.registerTx))
    changeTo(registerChip, states[2] === "done" ? chip("Confirmed", "ok") : states[2] === "active" ? chip("Sent", "brand")
      : view.revealAfter !== null && now / 1000 >= view.revealAfter ? (refused ? chip("Not signed", "bad") : chip("Signing", "brand")) : chip("After the wait"))
  }
  set(view, states, refused, now)
  return { node: el("div", { class: "panel-sec txs" }, tx("Commit", commitHash, commitChip), tx("Register", registerHash, registerChip),
    tx("Owner", el("span", { class: "v mono" }, onChain(view, "address", view.owner, shortAddress(view.owner))))), set }
}

function paidRows(view: api.RegistrationView, invoice: api.InvoiceView | null): [string, string | Node][] {
  const paid: [string, string] = invoice ? ["Paid", `${dollars(invoice.amount, true)} · ${methodName(invoice.cryptoCurrency ?? "card")}`] : ["Paid", "With a code"]
  return [paid, ["Term", termText(view.years)], ["Reference", shortRef(invoice?.invoiceId ?? view.id)]]
}

const stagesOf = (view: api.RegistrationView): StageState[] => view.phase === "registering" ? ["done", "done", "active"] : view.phase === "committed" ? ["done", "active", ""] : ["active", "", ""]

function headingOf({ view, record }: OrderState): (Node | string)[] {
  const label = labelOf(view!, record)
  return label ? ["Registering ", gradName(label, view!.tld)] : ["Registering the name"]
}

const MINUTE_S = 60
function waitEstimate(view: api.RegistrationView): string {
  const left = waitLeft(view)
  if (view.phase !== "committed" || left <= 0) return ""
  if (left < MINUTE_S) return "Under a minute. "
  const minutes = Math.round(left / MINUTE_S)
  return minutes === 1 ? "About a minute. " : `About ${minutes} minutes. `
}

function leadOf({ view, record }: OrderState): string {
  const keepOpen = openedFromApp(view!, record) ? "Keep this page open while SimpleX finishes it."
    : record ? "Keep this page open: after the wait it signs the name to finish it."
      : "The browser with its name code signed it."
  return `${waitEstimate(view!)}${keepOpen}`
}

const WAIT_NOTE = "The contract makes every registration wait after its commit, so nobody can take a name they saw being registered."
const COMMIT_NOTE = "Waiting for the commit to be mined. The wait starts once it is."
const REGISTERING_NOTE = "Registering the name on chain. It is yours once the transaction is mined."

function buildRegistering(state: OrderState, signal: AbortSignal): Built<OrderState> {
  let shown = state
  const steps = track(stagesOf(state.view!))
  const txs = txRows(state.view!, stagesOf(state.view!), state.now)
  const clockNode = live(el("b", {}))
  const note = live(el("p", {}))
  const problem = live(el("div", {}))
  const barOf = ({ view, record, invoice }: OrderState) => crumbs("Registration", { fromApp: openedFromApp(view!, record), prepaid: !invoice })
  const bar = barOf(state)
  const named = live(el("div", {}))
  const head = pageHead(headingOf(state), leadOf(state), bar)
  const heading = live(head.querySelector("h1")!)
  const lead = live(head.querySelector<HTMLElement>(".lead")!)
  const tryAgain = () => {
    dispatch({ type: "reveal-retried" })
    refresh()
  }
  let filling: number | null = null
  const show = (next: OrderState) => {
    const { record } = next
    const view = next.view!
    steps.set(stagesOf(view))
    changeTo(heading, ...headingOf(next))
    crumbsTo(bar, barOf(next))
    changeTo(named, cardName(labelOf(view, record), view.tld))
    changeTo(problem, ...(refusalsOf(next) >= REVEAL_ATTEMPTS ? [el("div", { class: "mt-18" }, alertBox("danger", "alert", "The name could not be signed", "The service refused the signed registration."),
      el("div", { class: "mt-14" }, btn("Try again", "quiet", tryAgain, icon("refresh"))))] : []))
    if (view.phase === "committed" && filling !== view.revealAfter) {
      filling = view.revealAfter
      fillWait(steps.node.children[1] as HTMLElement, view)
    }
  }
  const tick = () => {
    const { record } = shown
    const view = shown.view!
    const refused = refusalsOf(shown) >= REVEAL_ATTEMPTS
    changeTo(lead, leadOf(shown))
    txs.set(view, stagesOf(view), view.label === null && refused, shown.now)
    const left = waitLeft(view)
    if (view.phase === "committed" && left > 0) {
      rollTo(clockNode, clock(left), true)
      return changeTo(note, WAIT_NOTE)
    }
    if (!current(clockNode, "svg")) clockNode.replaceChildren(icon("clock"))
    if (view.phase !== "committed") return changeTo(note, view.phase === "registering" ? REGISTERING_NOTE : COMMIT_NOTE)
    waitsSeen.delete(view.id)
    if (openedFromApp(view, record) && view.label === null) changeTo(note, "Waiting for SimpleX to sign the registration with your app's wallet.")
    else if (view.label === null && refused) changeTo(note, "The registration is not signed yet.")
    else changeTo(note, REGISTERING_NOTE)
  }
  show(state)
  const turn = onTheSecond(() => waitLeft(shown.view!), tick, signal)
  const update = (next: OrderState) => {
    shown = next
    show(next)
    turn()
  }
  return { sections: [head, twoCols(el("div", { class: "panel" }, el("div", { class: "panel-sec" }, steps.node, el("div", { class: "countdown" }, clockNode, note), problem), txs.node),
    orderCard(named, paidRows(state.view!, state.invoice)))], update }
}

const waitsSeen = new Map<string, number>()
const waitLeft = (view: api.RegistrationView) => (view.revealAfter ?? 0) - api.serviceNow() / 1000
function fillWait(stage: HTMLElement, view: api.RegistrationView): void {
  const now = api.serviceNow()
  const end = (view.revealAfter ?? 0) * 1000
  if (!waitsSeen.has(view.id)) waitsSeen.set(view.id, now)
  const start = waitsSeen.get(view.id)!
  if (end <= now) return stage.style.setProperty("--done", "1")
  stage.animate([{ "--done": 0 }, { "--done": 1 }], { duration: end - start, fill: "forwards" }).currentTime = now - start
}

const TURN_SLACK_MS = 20
function onTheSecond(left: () => number, f: () => void, signal: AbortSignal): () => void {
  if (signal.aborted) return () => undefined
  let id: ReturnType<typeof setTimeout> | undefined
  const next = () => {
    clearTimeout(id)
    f()
    const l = left()
    id = setTimeout(next, l > 0 ? (l % 1) * 1000 + TURN_SLACK_MS : 1000)
  }
  signal.addEventListener("abort", () => clearTimeout(id), { once: true })
  next()
  return next
}

function buildNotOnDevice({ view, invoice }: OrderState): Built<OrderState> {
  return unchanging([status("info", "key", "The name code is not in this browser",
    ["This order registers a name to ", el("span", { class: "nowrap" }, shortAddress(view!.owner)), ". Its code was made in the browser it was bought in. Enter the code you saved before paying to carry on here."],
    [btn("Enter your name code", "", () => go("/#/restore"), icon("arrow"))], { reference: invoice?.invoiceId ?? view!.id })])
}

const recordPicture = (record: store.OrderRecord | null) => record ? record.ownerCode ?? "app" : ""

function buildRegistered(done: OrderState): Built<OrderState> {
  const view = done.view!
  const label = labelOf(view, done.record)
  // the tick draws itself, its stroke measured as one so the drawing needs no length
  const tick = icon("check")
  tick.querySelectorAll("path").forEach((p) => p.setAttribute("pathLength", "1"))
  const lead = live(el("p", { class: "lead" }))
  const body = live(el("div", {}))
  const update = ({ record }: OrderState) => {
    changeTo(lead, registeredLead(view, record))
    drawAs(body, recordPicture(record), () => [registeredBody(view, record, done.now)])
  }
  update(done)
  return { sections: [el("section", { class: "celebrate" }, el("div", { class: "wrap" },
    el("div", { class: "tick" }, tick),
    el("h1", { class: "display" }, label ? gradName(label, view.tld) : "The name", el("br"), "is yours"),
    lead)), body], update }
}

function registeredLead(view: api.RegistrationView, record: store.OrderRecord | null): string {
  const until = view.expiresAt ? dateOf(view.expiresAt) : ""
  if (record?.ownerCode) return `Registered for ${termText(view.years)}, until ${until}, to ${shortAddress(view.owner)}, the wallet of your name code.`
  if (record) return `Registered for ${termText(view.years)}, until ${until}, to your app's wallet, ${shortAddress(view.owner)}.`
  return view.sealed === null ? `Registered until ${until} to the wallet of the app it was ordered from, ${shortAddress(view.owner)}.`
    : `Registered until ${until} to ${shortAddress(view.owner)}. Its name code is not in this browser.`
}

function registeredBody(view: api.RegistrationView, record: store.OrderRecord | null, now: number): HTMLElement {
  const states: StageState[] = ["done", "done", "done"]
  if (!record?.ownerCode) {
    const back = record
      ? btn("Back to SimpleX", "block", () => { location.href = "simplex:/" }, icon("arrow"))
      : withoutRecord(view, "quiet block", "Restore with your name code")
    return el("div", { class: "wrap narrow" }, el("div", { class: "panel" },
      el("div", { class: "panel-sec" }, track(states).node), txRows(view, states, now).node, el("div", { class: "panel-sec" }, back)))
  }
  const next = (ic: Parameters<typeof icon>[0], title: string, text: string, action: Node | null) =>
    el("div", { class: "item" }, el("span", { class: "ic" }, icon(ic)), el("div", {}, el("b", {}, title), el("p", {}, text), action))
  return twoCols(
    el("div", { class: "panel" }, el("div", { class: "panel-sec" },
      el("div", { class: "sec-title" }, el("h2", {}, "Your name code")),
      el("p", { class: "sec-note" }, "The name code it was ordered with. It owns the name."),
      codeDisplay(record.ownerCode, "owner-code"),
      store.canPersist()
        ? alertBox("warn", "shield", null, "Whoever has this code controls the name. Nobody else has a copy, not even us.")
        : alertBox("danger", "alert", "This code could not be saved in this browser", "The copy you saved before paying is the only one."))),
    el("aside", { class: "panel summary" },
      el("span", { class: "label" }, "Next steps"),
      el("div", { class: "next mt-12" },
        next("phone", "Redeem it in the app", "Scan or enter the code in SimpleX: the name moves to the app's wallet.",
          el("div", { class: "qr mt-10" }, qrSvg(record.ownerCode, "name code"))),
        next("link", "Point it at your address", "Link your contact address or channel.", el("a", { href: `/#/edit/${view.id}` }, "Edit links")),
        next("key", "Keep the code safe", "Until you redeem it, it is the only key to the name.", null))))
}

function buildTakenWithCode(taken: OrderState): Built<OrderState> {
  const view = taken.view!
  const label = labelOf(view, taken.record)
  const code = live(el("div", {}))
  const actions = actionRow()
  const update = ({ record }: OrderState) => {
    const released = releasedCode(view, record)
    drawAs(code, released?.code ?? "", () => released ? [codeDisplay(released.code)] : [])
    drawAs(actions, released?.code ?? "", () => [released
      ? btn("Use it for another name", "", () => useCode({ ...released, addedAt: "" }), icon("arrow"))
      : btn("Search another name", "", () => go("/#/"))])
  }
  update(taken)
  return { sections: [status("info", "key", "Someone registered it first",
    [label ? nameText(label, view.tld) : "The name", " was registered just before ours. Your code was not spent: use it for another name."],
    [], { reference: view.id, extra: [code, actions] })], update }
}

function buildTaken(state: OrderState, signal: AbortSignal): Built<OrderState> {
  const { view: taken, record, invoice } = state
  if (!invoice) return buildTakenWithCode(state)
  const view = taken!
  const label = labelOf(view, record)
  const paid = dollars(invoice.amount, true)
  // the order's worth caps another name; after a move to a cheaper name it is lower than what was paid
  const kept = dollars(view.price, true)
  const other = btn("Choose another name", "block", () => go(`/#/?retarget=${view.id}`))
  const note = liveRegion()
  const code = btn("Take a code", "quiet block", () => void takeCode())
  const fromApp = openedFromApp(view, record)
  const watchHold = holdEnds(signal)
  const cannot = live(el("div", {}))
  const cannotAct = (next: OrderState) => next.record?.ownerCode ? [] : [el("div", { class: "mt-16" }, openedFromApp(view, next.record)
    ? alertBox("info", "phone", "This order was opened from SimpleX", "Choose another name or take a code in the app.")
    : alertBox("info", "key", "The name code is not in this browser", "Restore it in Your names to choose another name or take a code."))]
  const update = (next: OrderState) => {
    const canAct = Boolean(next.record?.ownerCode)
    drawAs(cannot, canAct ? "" : openedFromApp(view, next.record) ? "app" : "restore", () => cannotAct(next))
    setAction(other, false, !canAct)
    setAction(code, canAct && next.busy === "code", !canAct || next.hold !== null)
    showNote(note, next, "mt-14", canAct)
    watchHold(next.hold !== null)
  }
  update(state)
  return { sections: [pageHead("Someone registered it first", [label ? nameText(label, view.tld) : "The name", " was registered just before ours. Your payment is kept."], crumbs("Registration", { fromApp })),
    twoCols(el("div", { class: "panel" },
      el("div", { class: "panel-sec" }, track(["done", "done", "failed"]).node,
        el("p", { class: "sec-note mt-18 mb-0" }, "Another registration of this name went through first, so ours could not."),
        cannot,
        el("div", { class: "options" },
          el("div", { class: "option" }, el("b", {}, "Choose another name"), el("p", {}, `Any name of up to ${kept}, registered to the same wallet, so your code owns it.`), other),
          el("div", { class: "option" }, el("b", {}, "Take a code instead"), el("p", {}, `A code for names of ${codeTier(label?.length ?? LONGEST_TIER)} or more letters, for 2 years, to use here or in the app.`), code)), note)),
    orderCard(cardName(label, view.tld), [["Paid", `${paid} · ${methodName(invoice.cryptoCurrency ?? "card")}`], ["Kept", kept], ["Reference", fullRef(invoice.invoiceId)]]))], update }
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

const issuedPicture = ({ view, record }: OrderState) => openedFromApp(view!, record) ? "app" : record?.ownerCode ?? ""

function buildCodeIssued(issued: OrderState): Built<OrderState> {
  const body = live(el("div", {}))
  const update = (next: OrderState) => drawAs(body, issuedPicture(next), () => [issuedStatus(next)])
  update(issued)
  return { sections: [body], update }
}

function issuedStatus({ view: issued, record }: OrderState): HTMLElement {
  const view = issued!
  if (openedFromApp(view, record)) {
    return status("info", "key", "This order became a code", "The app the order was opened from shows the code.", [btn("Search a name", "", () => go(searchFrom(view, record)))], { reference: view.id })
  }
  if (!record?.ownerCode) {
    return status("info", "key", "This order became a code", "The code is made from the order's name code, so it shows in the browser that has it. Restore the name code here to see it.",
      [btn("Enter your name code", "", () => go("/#/restore"), icon("arrow"))], { reference: view.id })
  }
  const code = record.takenCode ?? flow.takenCodeOf(record, view.id)
  return status("ok", "key", "Here is a code instead", [`For names of ${codeTier(record.label.length)} or more letters, for 2 years: what `, nameText(record.label, view.tld), " was paid for."],
    [btn("Search another name", "quiet", () => go("/#/"))],
    { extra: [codeDisplay(code),
      el("div", { class: "center mt-16" }, el("div", { class: "qr" }, qrSvg(code, "code"))),
      el("div", { class: "left" }, alertBox("info", "info", "Keep a copy of this code", "The service keeps only its hash; this browser keeps the code, under Your names."))] })
}

// The code is said to be kept only once the service says so; a browser that restored the order has not got its code.
const failedLead = ({ invoice, codeRefused, codeKept, record }: OrderState) => invoice ? "Your payment is kept. Trying again charges nothing."
  : codeRefused ? "Your code can no longer pay for it, so trying again cannot register it."
  : record?.prepaidCode && codeKept ? "Your code is kept. Trying again spends nothing more." : "Trying again spends nothing more."

function buildFailed(state: OrderState, signal: AbortSignal): Built<OrderState> {
  const { view: failed, record, invoice } = state
  const view = failed!
  const label = labelOf(view, record)
  const note = liveRegion()
  const again = btn("Try again", "", () => void retryRegistration(), icon("refresh"))
  // a code refused for good leaves nothing to try again, so the page offers another search as the other endings do
  const action = live(el("div", { class: "mt-18" }))
  const elsewhere = btn("Search a name", "quiet", () => go(searchFrom(view, record)))
  const head = pageHead(invoice ? "Paid, not registered" : "Not registered", failedLead(state), crumbs("Registration", { fromApp: openedFromApp(view, record), prepaid: !invoice }))
  const lead = live(head.querySelector<HTMLElement>(".lead")!)
  const watchHold = holdEnds(signal)
  const update = (next: OrderState) => {
    changeTo(lead, failedLead(next))
    setAction(again, next.busy === "retry", next.hold !== null)
    drawAs(action, String(next.codeRefused), () => [next.codeRefused ? elsewhere : again])
    showNote(note, next, "mt-14", true)
    watchHold(next.hold !== null)
  }
  update(state)
  const failedAt: StageState[] = view.commitTx === null ? ["failed", "", ""] : ["done", "done", "failed"]
  return { sections: [head,
    twoCols(el("div", { class: "panel" },
      el("div", { class: "panel-sec" }, track(failedAt).node,
        el("div", { class: "mt-22" }, alertBox("danger", "alert", view.error ?? "The registration did not go through", "The service's own retries gave up.")),
        note, action)),
    orderCard(cardName(label, view.tld), [...paidRows(view, invoice).slice(0, 1), ["Charged again", "Never"], ["Reference", fullRef(invoice?.invoiceId ?? view.id)]]))], update }
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

const BUILDS: Record<OrderKind, Build<OrderState>> = {
  "pay-crypto": buildPayCrypto,
  "pay-card": buildPayCard,
  confirming: buildConfirming,
  slow: buildSlow,
  registering: buildRegistering,
  registered: buildRegistered,
  taken: buildTaken,
  "code-issued": buildCodeIssued,
  failed: buildFailed,
  "not-on-device": buildNotOnDevice,
  "status:paid-late": buildPaidLate,
  "status:paid-by-invoice": buildPaidByInvoice,
  "status:still-open": buildStillOpen,
  "status:expired-cancelled": buildExpired,
  "status:expired-received": buildExpired,
  "status:expired": buildExpired,
  "status:card-failed": buildCardFailed,
  "status:unreadable": buildUnreadable,
  "status:unknown-link": buildUnknownLink,
  "status:price-changed": buildPriceChanged,
}
