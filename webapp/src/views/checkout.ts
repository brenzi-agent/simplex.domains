// The checkout's steps: the links the name opens, its name code, and Check your order with how it pays, and Pay.
import * as api from "../api.ts"
import { alertBox, btn, codeDisplay, el, icon, type Kid, link, nameText, nameTitle, setAction } from "../dom.ts"
import * as flow from "../flow.ts"
import { dateOf, dollars, methodName, SEP, termText, untilFromNow } from "../format.ts"
import { type Method, methodMark } from "../icons.ts"
import { type LinkKind, PRICED_YEARS, priceFor } from "../names.ts"
import { changeOf, type CheckoutEvent, type CheckoutKind, type CheckoutState, initialState, reduce, screenOf, stepFor, type WaitingOrder } from "../screens/checkout.ts"
import { type CheckoutStep, checkoutUrl } from "../screens/routes.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { clearTyped, CODE_ERRORS, codeField, type CodeVerdict, refuseCode } from "./codes.ts"
import { focusUnsettled, linkEntry, linkField, linkName, linkPreview } from "./links.ts"
import {
  asStep, type Builder, currentRoute, draw, focusOn, go, goFrom, isRedraw, isRoute, kept, keptLive, limitScreen, outcome, redirect, refresh, screen, searchLink, whenLeaving,
} from "./shell.ts"
import { holdEnd, holdEnder, holdFrom, holding, holdNotice, tabHold } from "./hold.ts"
import { openedInstead } from "./order.ts"

const METHOD_ORDER: Method[] = ["card", "btc", "xmr"]
// a field per name, so what was typed in it stays with its checkout
const codeKey = (label: string) => `checkout-code-${label}`
const CODE_LABEL = "I have a code"
const CHECKOUT_NOTE = "checkout-note"
const PAY_WITH_ID = "pay-with-label"
const SAVED_LABEL = "I have saved my name code"
const LINK_KINDS: LinkKind[] = ["contact", "channel"]

const years = (c: session.Checkout) => c.code?.years ?? PRICED_YEARS
// a card order waiting for Stripe holds a second paid order; a code pays nothing, so it holds none
const blockedBy = ({ checkout, waiting }: CheckoutState) => checkout.code ? null : waiting
const payLabel = (c: session.Checkout) => c.code ? "Register" : c.appOwner ? "Continue" : `Pay ${dollars(c.price, true)} with ${methodName(c.method)}`

function waitingCardOrder(): WaitingOrder | null {
  const order = store.orders().find((o) => o.method === "card" && o.cardSubmittedAt && o.invoiceId)
  return order ? { registrationId: order.registrationId, invoiceId: order.invoiceId! } : null
}

let state: CheckoutState
let shown: CheckoutKind | null = null
let pageRoute = -1
// a code verdict that came while the order was on its way, heard once the order comes back to the checkout
let unheard: CodeVerdict | null | undefined

// The name code is made as its step opens and kept as pending, so Your names lists it before any order exists.
export function checkoutPage(asked: CheckoutStep): void {
  const stored = session.checkout()
  if (!stored) return redirect("/#/")
  const step = stepFor(stored, asked)
  if (step !== asked) return redirect(checkoutUrl(step))
  session.setCheckout({ ...stored, step, ownerCode: stored.ownerCode ?? (step === "code" ? flow.newOwnerCode() : null) })
  const c = session.checkout()!
  if (c.ownerCode) store.addPending({ ownerCode: c.ownerCode, label: c.label, tld: c.chain.tld, createdAt: new Date().toISOString() })
  if (!isRedraw() || shown === null || state.checkout.label !== c.label) {
    // a code field opened stays open over Change and Back within the same checkout
    state = initialState(c, step, shown !== null && state.checkout.label === c.label && state.checkout.ownerCode === c.ownerCode && state.codeOpen)
    shown = null
    unheard = undefined
  }
  pageRoute = currentRoute()
  // a wait met elsewhere in the tab holds this page's actions too
  dispatch({ type: "opened", step, checkout: c, sending: session.isSending(c), waiting: waitingCardOrder(), hold: tabHold() })
  if (step !== "review") return
  const reads = new AbortController()
  whenLeaving(() => reads.abort())
  if (state.waiting) void settleWaiting(state.waiting, reads.signal)
  else void showOpenOrder(reads.signal)
}

function dispatch(event: CheckoutEvent): void {
  state = reduce(state, event)
  if (!isRoute(pageRoute)) return
  const kind = screenOf(state)
  shown = kind
  draw(kind, (signal) => asStep(BUILDERS[kind](state, signal)), state.step)
  if (kind !== "review" || state.sending || unheard === undefined) return
  const late = unheard
  unheard = undefined
  heed(late)
}

const holdEnds = (signal: AbortSignal) => holdEnder(signal, () => dispatch({ type: "hold-ended" }))

// A change of the order is written to the tab's checkout before the page takes it; a page whose checkout the tab has
// moved on from changes nothing. False when it did not take it.
function act(event: CheckoutEvent, apply: (event: CheckoutEvent) => void = dispatch): boolean {
  const change = changeOf(state, event)
  if (change && !session.updateCheckout(state.checkout.label, change)) return false
  apply(event)
  return true
}

// a link typed is shown by its own field, so the page takes it without drawing
const setLink = (kind: LinkKind, link: string) => void act({ type: "link-set", kind, link }, (event) => { state = reduce(state, event) })

const RETRY_MS = 3000

// The card order blocks a second one only while its invoice is open, so checkout follows it and opens up when it settles or closes.
async function settleWaiting(waiting: WaitingOrder, signal: AbortSignal): Promise<void> {
  let seen: api.InvoiceView | undefined
  while (!signal.aborted) {
    try {
      seen = await api.readInvoice(waiting.invoiceId, seen && { status: seen.status, phase: seen.registration.phase, paid: seen.cryptoAmountPaid ?? "", full: seen.paidInFull === true }, signal)
    } catch (e) {
      // the service forgets an unpaid invoice some time after it closes; other errors are waited out
      if (e instanceof api.ApiError && e.code === "not_found") return settled(waiting, signal)
      if (signal.aborted) return
      await new Promise((r) => setTimeout(r, e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS))
      continue
    }
    if (seen.status !== "open") return settled(waiting, signal)
  }
}

function settled(waiting: WaitingOrder, signal: AbortSignal): void {
  store.updateOrder(waiting.registrationId, { cardSubmittedAt: undefined })
  store.clearCardSubmitted(waiting.invoiceId)
  if (signal.aborted) return
  dispatch({ type: "waiting-settled" })
  void showOpenOrder(signal)
}

const OPEN_ORDER_LOOKBACK = 5

// An unpaid invoice this browser made is pointed at, without blocking a new order. Only the newest few orders are asked
// about, so a long Your names list does not cost a request each.
async function showOpenOrder(signal: AbortSignal): Promise<void> {
  const recent = store.orders().filter((o) => o.invoiceId && !o.cancelled && !o.replacedBy).slice(0, OPEN_ORDER_LOOKBACK)
  const invoices = await Promise.all(recent.map((o) => api.readInvoice(o.invoiceId!).catch(() => null)))
  const at = invoices.findIndex((i) => i?.status === "open" && i.registration.phase === "unpaid")
  if (at < 0 || signal.aborted) return
  const { invoiceId, label, tld } = recent[at]
  dispatch({ type: "open-order-seen", order: { invoiceId: invoiceId!, label, tld, confirming: invoices[at]!.paidInFull === true } })
}

// Change opens the links step with focus in the field chosen
function linkLine(kind: LinkKind, key: string, value: Node | string, action: string, name: string): HTMLElement {
  const change = link(action, () => { go(checkoutUrl("links")); focusOn(`link-${kind}`) })
  change.setAttribute("aria-label", name)
  change.dataset.focus = `change-${kind}`
  return el("div", { class: "link-line" }, el("span", { class: "k" }, key), value, change)
}

function linkLines(c: session.Checkout): HTMLElement | null {
  if (c.appOwner) return null
  const set = LINK_KINDS.filter((kind) => c[kind])
  return el("div", { class: "link-lines" }, set.length
    ? set.map((kind) => linkLine(kind, linkName(kind), linkPreview(c[kind]), "Change", `Change the ${linkName(kind).toLowerCase()}`))
    : linkLine("contact", "Links", el("span", {}, "None"), "Add", "Add links"))
}

// the term and its price on one line, as the search answer shows them
function summaryCard(c: session.Checkout): HTMLElement {
  const y = years(c)
  return el("section", { class: "card summary-card" }, nameTitle(c.label, "name", c.chain.tld),
    el("div", { class: "total" }, el("span", { class: "term-line" }, termText(y), SEP, el("span", { class: "nowrap" }, `until ${dateOf(untilFromNow(y), true)}`)),
      el("b", { class: "nowrap" }, ...(c.code ? [el("s", {}, dollars(priceFor(c.price, y), true)), "$0.00"] : [dollars(c.price, true)]))),
    linkLines(c))
}

// an order on its way is sent as it is: its method and code stay as they are until it is answered
function locked<T extends HTMLElement>(node: T, sending: boolean): T {
  for (const input of node.querySelectorAll("input")) input.disabled = sending
  return node
}

function chooseMethod(m: Method): void {
  if (state.sending || m === state.checkout.unavailable || !act({ type: "method-chosen", method: m })) return
  focusOn(`method-${m}`)
}

function methodsBlock({ checkout: c, openOrder: order, sending }: CheckoutState): HTMLElement {
  // one Tab stop for the group, as a radio group has; arrows move between the methods open to choose
  const keyed = (e: KeyboardEvent, m: Method) => {
    const open = METHOD_ORDER.filter((other) => other !== state.checkout.unavailable)
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
    if (e.key === "Enter" || e.key === " ") chooseMethod(m)
    else if (by) chooseMethod(open[(open.indexOf(m) + by + open.length) % open.length])
    else return
    e.preventDefault()
  }
  const radios = METHOD_ORDER.map((m) => {
    const [on, off] = [m === c.method, m === c.unavailable]
    return el("div", { class: "method", role: "radio", "data-method": m, "data-focus": `method-${m}`, "aria-checked": String(on), "aria-disabled": off || sending ? "true" : undefined,
      tabindex: on ? "0" : "-1", onclick: () => chooseMethod(m), onkeydown: (e: Event) => keyed(e as KeyboardEvent, m) },
    methodMark(m), el("b", {}, methodName(m)), off ? el("span", {}, "Temporarily unavailable") : null)
  })
  return el("section", { class: "pay-with" },
    order ? alertBox("info", "clock", `${order.label}.${order.tld} ${order.confirming ? "is confirming its payment" : "is waiting for its payment"}`,
      el("a", { href: store.invoiceUrl(order.invoiceId) }, "Open that order")) : null,
    c.unavailable ? alertBox("warn", "alert", `${methodName(c.unavailable)} is temporarily unavailable`, "Try another method, or come back later.") : null,
    el("span", { class: "label", id: PAY_WITH_ID }, "Pay with"),
    el("div", { class: "methods", role: "radiogroup", "aria-labelledby": PAY_WITH_ID }, ...radios))
}

const coveredLine = (code: session.AppliedCode) => el("section", { class: "pay-with" },
  alertBox("ok", "check", "Paid with your code", `Registered for ${termText(code.years)}, with nothing to pay.`))

const waitingNotice = (blocked: WaitingOrder) => el("section", { class: "pay-with" },
  alertBox("info", "info", "You have an order waiting to be confirmed", "A second order would be a second charge, so this one cannot start yet. When that payment is confirmed or expires, you can start a new one here."),
  el("div", {}, btn("Open the waiting order", "quiet", () => go(store.invoiceUrl(blocked.invoiceId)))))

const tooShort = (v: CodeVerdict | null, label: string) => v?.ok === true && label.length < v.code.minLength

// A code that pays is applied, and anything else takes off the code the field held. Read from the module's state, as
// the field is kept across draws.
function heed(v: CodeVerdict | null): void {
  const { label, code, codeError } = state.checkout
  if (v?.ok && !tooShort(v, label)) act({ type: "code-applied", code: v.code })
  // an edit takes off the code the field held, and the service's last refusal of one
  else if (code || codeError) act({ type: "code-removed" })
}

// The field's verdict, heard at once unless the order on its way was sent without it; one for longer names is refused here.
function onVerdict(v: CodeVerdict | null): string | null {
  const { label } = state.checkout
  if (state.sending) unheard = v
  else heed(v)
  return v?.ok && tooShort(v, label) ? `This code covers names of ${v.code.minLength} or more letters; ${label} has ${label.length}.` : null
}

const codeEntry = () => codeField(codeKey(state.checkout.label), CODE_LABEL, onVerdict, state.checkout.code, state.checkout.codeError ?? null)

// the link the field opens from is drawn away, so focus goes into the field, which is where the link was in view
function openCode(): void {
  dispatch({ type: "code-opened" })
  codeEntry().querySelector("input")!.focus({ preventScroll: true })
}

// the link holds the field's place, so the field opens without moving the page
const codeBlock = (s: CheckoutState) => s.codeOpen ? locked(codeEntry(), s.sending) : el("div", { class: "field code-link" }, link(CODE_LABEL, openCode))

const actionLabel = (text: string, s: CheckoutState) => s.sending && !s.busy ? "Sending your order…" : text

function payBlock(s: CheckoutState, blocked: boolean, signal: AbortSignal): HTMLElement {
  const pay = btn(actionLabel(payLabel(s.checkout), s), "block", () => void submitOrder(), icon("arrow"))
  pay.dataset.focus = "pay"
  setAction(pay, s.busy, blocked || s.sending || s.hold !== null)
  const held = !blocked && !s.sending ? s.hold : null
  holdEnds(signal)(s.hold !== null)
  return el("div", { class: "pay-block" }, pay, keptLive(CHECKOUT_NOTE, undefined, held && holdNotice(held, signal)))
}

function continueButton(onclick: () => void, held = false, label: Kid = "Continue"): HTMLButtonElement {
  const next = setAction(btn(label, "block", onclick, icon("arrow")), false, held)
  next.dataset.focus = "continue"
  return next
}

// a link refused or being checked takes focus; until the code is saved, the review opens the name code step instead
function linksDone(fields: HTMLElement[]): void {
  if (!focusUnsettled(fields)) go(checkoutUrl("review"))
}

function buildLinks(s: CheckoutState): HTMLElement {
  const c = s.checkout
  const fields = [
    locked(kept("link-contact", () => linkField("contact", c.contact, (link) => setLink("contact", link))), s.sending),
    locked(kept("link-channel", () => linkField("channel", c.channel, (link) => setLink("channel", link))), s.sending),
  ]
  // one button, named Skip for now while both fields are empty and Continue once a link is typed, so the step keeps still
  return screen({ title: "What should your name open?", back: searchLink(c.label, null),
    lead: ["When someone opens ", nameText(c.label, c.chain.tld), " in SimpleX, it connects them to you or shows your channel. Paste the links from the app; you can change them later."] },
    el("div", { class: "link-fields" }, linkEntry("contact", fields[0]), linkEntry("channel", fields[1])),
    continueButton(() => linksDone(fields), false, [el("span", { class: "skip" }, "Skip for now"), el("span", { class: "go" }, "Continue")]))
}

function buildCode(s: CheckoutState): HTMLElement {
  const c = s.checkout
  const box = el("input", { type: "checkbox", checked: c.saved, disabled: s.sending, "data-focus": "saved" })
  box.addEventListener("change", () => { if (!state.sending && !act({ type: "saved", saved: box.checked })) refresh() })
  return screen({ title: "Save your name code", lead: ["It is the only key to ", nameText(c.label, c.chain.tld), ". If you lose it, nothing can recover it."], back: checkoutUrl("links") },
    codeDisplay(c.ownerCode!, "owner-code"),
    store.canPersist() ? null : alertBox("danger", "alert", "This code could not be saved in this browser", "Save a copy now: it will be the only one."),
    el("label", { class: "check" }, box, el("span", { class: "box" }), SAVED_LABEL),
    continueButton(() => go(checkoutUrl("review")), !c.saved))
}

function buildReview(s: CheckoutState, signal: AbortSignal): HTMLElement {
  const c = s.checkout
  const fromApp = c.appOwner !== null
  const blocked = blockedBy(s)
  return screen({ title: "Check your order", back: fromApp ? searchLink(c.label, c.appOwner) : checkoutUrl("code") },
    el("div", { class: "review" }, summaryCard(c),
      fromApp && !store.canPersist() ? alertBox("warn", "alert", "This browser will not keep this order", "Keep this page open until the name is registered; a reload loses it.") : null,
      c.code ? coveredLine(c.code) : blocked ? waitingNotice(blocked) : methodsBlock(s),
      fromApp ? null : codeBlock(s),
      payBlock(s, blocked !== null, signal)))
}

function buildPriceChanged({ checkout: c }: CheckoutState): HTMLElement {
  return outcome({ tone: "warn", icon: "alert", title: "The price changed",
    text: [nameText(c.label, c.chain.tld), ` costs ${dollars(c.price, true)} now; it changed while you were deciding. Nothing was charged.`],
    action: btn("Search again", "", () => go(searchLink(c.label, c.appOwner))) })
}

function buildTooMany({ checkout: c, hold }: CheckoutState, signal: AbortSignal): HTMLElement {
  holdEnds(signal)(hold !== null)
  return limitScreen(hold, refresh, searchLink(c.label, c.appOwner), signal)
}

function buildTaken({ checkout: c }: CheckoutState): HTMLElement {
  return outcome({ tone: "info", icon: "info", title: "This name is no longer available", text: [nameText(c.label, c.chain.tld), " became unavailable after you searched for it. Nothing was charged."],
    action: btn("Search another name", "", () => go(searchLink("", c.appOwner))) })
}

function buildFailed(s: CheckoutState): HTMLElement {
  const c = s.checkout
  // the same order is sent again from here; Back leaves it for the search
  const retry = setAction(btn("Try again", "", () => void submitOrder()), s.busy, false)
  return outcome({ tone: "danger", icon: "alert", title: "That did not go through", text: "Nothing was charged. If this happens again, get in touch.",
    action: el("div", { class: "actions" }, retry, btn("Back", "quiet", () => go(searchLink(c.label, c.appOwner)))) })
}

const BUILDERS: Record<CheckoutKind, Builder<CheckoutState>> = {
  links: buildLinks,
  code: buildCode,
  review: buildReview,
  "status:price-changed": buildPriceChanged,
  "status:too-many": buildTooMany,
  "status:failed": buildFailed,
  "status:taken": buildTaken,
}

async function submitOrder(): Promise<void> {
  const c = session.checkout()
  if (!c) return go("/#/names")
  if (session.isSending(c) || holding()) return
  // a card payment awaiting confirmation, met since the page was drawn, blocks a second paid order; the page shows it
  if (!c.code && waitingCardOrder()) return refresh()
  session.startSending(c)
  try {
    await sendOrder()
  } finally {
    session.stopSending(c)
  }
}

async function sendOrder(): Promise<void> {
  const c = session.checkout()
  // a page left open while its order went through, in this tab or by Back and Forward, has nothing left to send
  if (!c) return go("/#/names")
  dispatch({ type: "send-started" })
  const fromApp = c.appOwner !== null
  const appSecret = fromApp ? c.appSecret ?? `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}` : null
  if (fromApp && !c.appSecret) session.setCheckout({ ...c, appSecret })
  const draft: flow.Draft = {
    label: c.label, links: { contact: c.contact, channel: c.channel }, chain: c.chain, years: years(c), ownerCode: c.ownerCode,
    ...(fromApp ? { appOwner: c.appOwner!, appSecret: appSecret! } : {}),
  }
  // The order is kept whatever the buyer did meanwhile. Its checkout ends, and the order opens, only while this checkout
  // is still the tab's: the buyer may have started another name, by Back and Forward too.
  const mine = currentRoute()
  const search = searchLink(c.label, c.appOwner)
  const done = (url: string) => {
    clearTyped(codeKey(c.label))
    const current = session.checkout()
    const ours = current?.label === c.label && current.ownerCode === c.ownerCode
    if (ours) session.setCheckout(null)
    if (!isRoute(mine) && !(ours && location.hash.startsWith("#/checkout"))) return
    // Back from the order returns once to its search, still opened from the app, past the checkout that has ended
    if (location.hash.startsWith("#/checkout")) goFrom(c.searchAt, search, url)
    else go(url)
  }
  let built: flow.BuiltOrder | null = null
  try {
    built = await flow.orderRequest(draft)
    if (c.code) {
      const res = await api.registerWithCode(built.request, c.code.display)
      if (res.invoiceId) return await openInvoice(draft, built, res.invoiceId, "code", done)
      store.saveOrder({ ...flow.recordFor(draft, built, "code", 0, { registrationId: res.registrationId, invoiceId: null }), prepaidCode: c.code.display })
      return done(store.orderUrl({ invoiceId: null, registrationId: res.registrationId }))
    }
    const res = await api.createOrder(built.request, c.method, c.price)
    const { method, paid } = flow.paidWith(res)
    store.saveOrder(flow.recordFor(draft, built, method, paid, { registrationId: res.registration.id, invoiceId: res.invoiceId }))
    done(store.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id }))
  } catch (e) {
    if (built && e instanceof api.ApiError && e.code === "bad_request" && typeof e.body.invoiceId === "string") return openInvoice(draft, built, e.body.invoiceId, c.code ? "code" : c.method, done)
    // the order did not go: its checkout is open to change again before the error page sends the buyer back to it
    session.stopSending(c)
    // a rate limit holds the tab's actions wherever the buyer has gone meanwhile
    holdFrom(e)
    // as on success: the error shows where the buyer still is in this checkout, by Back and Forward too
    const ours = session.checkout()?.label === c.label && session.checkout()?.ownerCode === c.ownerCode
    if (!isRoute(mine) && !(ours && location.hash.startsWith("#/checkout"))) return
    // a page whose checkout the tab has moved on from shows the tab's checkout now, which is not on its way
    if (!ours) return refresh()
    orderError(e, c)
  }
}

// This commitment already has an order, so this browser's code owns it: its record is kept before it opens, and its page
// says why it pays another way than the one chosen.
async function openInvoice(draft: flow.Draft, built: flow.BuiltOrder, invoiceId: string, chosen: Method | "code", done: (url: string) => void): Promise<void> {
  const invoice = await api.readInvoice(invoiceId).catch(() => null)
  if (invoice) {
    const had = invoice.cryptoCurrency ?? "card"
    store.saveOrder(flow.recordFor(draft, built, had, invoice.amount, { registrationId: invoice.registration.id, invoiceId }))
    if (had !== chosen) openedInstead({ invoiceId, had, chosen })
  }
  done(store.invoiceUrl(invoiceId))
}

function orderError(e: unknown, c: session.Checkout): void {
  const code = e instanceof api.ApiError ? e.code : "network"
  if (code === "name_taken") {
    // no order was made, so the name code made for it owns nothing to find later
    if (c.ownerCode) store.dropPending(c.ownerCode)
    return void act({ type: "order-refused", reason: "taken" })
  }
  if (code in CODE_ERRORS) {
    // the field is emptied for another code, so a verdict on the one it held is moot
    unheard = undefined
    // drawn first, so the field is open again for another code when it takes focus and says why
    act({ type: "order-refused", reason: "code", error: CODE_ERRORS[code] })
    return refuseCode(codeEntry(), CODE_ERRORS[code])
  }
  if (code === "provider_unavailable") return void act({ type: "order-refused", reason: "method" })
  if (code === "catalog_changed" && e instanceof api.ApiError && typeof e.body.price === "number") return void act({ type: "price-changed", price: e.body.price })
  // the tab's wait started as the order was refused; the page holds for what is left of it
  if (code === "rate_limited") return dispatch({ type: "hold-started", until: holdEnd() })
  dispatch({ type: "order-refused", reason: "failed" })
}
