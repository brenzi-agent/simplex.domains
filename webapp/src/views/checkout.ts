// The checkout's steps: the links the name opens, its name code, and Check your order with how it pays, and Pay.
import * as api from "../api.ts"
import { alertBox, btn, codeDisplay, el, line, link, nameText, nameTitle, setAction } from "../dom.ts"
import * as flow from "../flow.ts"
import { dateOf, dollars, freeDays, methodName, termEnd, termOf } from "../format.ts"
import { type Method, methodMark } from "../icons.ts"
import type { LinkKind } from "../names.ts"
import { heldWords, holdWait } from "../screens/balance.ts"
import { REVEAL_HOURS } from "../screens/order.ts"
import {
  balanceHeld, changeOf, heldForThisName, payWaits, type CheckoutEvent, type CheckoutKind, type CheckoutState, covered, initialState, reduce, screenOf, split, stepFor, type WaitingOrder,
} from "../screens/checkout.ts"
import { type CheckoutStep, checkoutUrl } from "../screens/routes.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { CODE_ERRORS } from "./codes.ts"
import { focusUnsettled, linkChat, linkFieldsFor } from "./links.ts"
import {
  asStep, type Builder, currentRoute, draw, focusOn, go, goFrom, isRedraw, isRoute, kept, keptLive, limitScreen, outcome, redirect, refresh, screen, searchLink, whenLeaving,
} from "./shell.ts"
import { after } from "./effects.ts"
import { holdEnd, holdEnder, holdFrom, holding, holdNotice, tabHold } from "./hold.ts"
import { openedInstead, RETRY_MS } from "./order.ts"

const METHOD_ORDER: Method[] = ["card", "btc", "xmr"]
const CHECKOUT_NOTE = "checkout-note"
const SAVED_LABEL = "I have saved my name code"
// the dApp that registers a name paid for in ETH
const DAPP_URL = "https://app.simplex.domains"
// the placeholder for the name terms, until their own page exists
const TERMS_URL = "https://simplex.chat/"
// the service takes a signed order's timestamp within this many seconds; an older one is signed anew
const SIGNED_WINDOW_S = 600

const years = (c: session.Checkout) => c.code?.years ?? c.years
// a card order waiting for Stripe holds a second paid order; a code or a balance that covers the price pays nothing, so it holds none
const blockedBy = ({ checkout, waiting }: CheckoutState) => checkout.code || covered(checkout) ? null : waiting
const payLabel = (c: session.Checkout) => c.code ? "Register with your code" : covered(c) ? "Register with your balance" : `Pay ${dollars(split(c).rest)} with ${methodName(c.method)}`

function waitingCardOrder(): WaitingOrder | null {
  const order = store.orders().find((o) => o.method === "card" && o.cardSubmittedAt && o.invoiceId)
  return order ? { registrationId: order.registrationId, invoiceId: order.invoiceId! } : null
}

let state: CheckoutState
let shown: CheckoutKind | null = null
let pageRoute = -1

// The name code is made as its step opens and kept as pending, so Your names lists it before any order exists.
export function checkoutPage(asked: CheckoutStep): void {
  const stored = session.checkout()
  if (!stored) return redirect("/#/")
  const step = stepFor(stored, asked)
  if (step !== asked) return redirect(checkoutUrl(step))
  session.setCheckout({ ...stored, step, ownerCode: stored.ownerCode ?? (step === "code" ? flow.newOwnerCode() : null) })
  const c = session.checkout()!
  // a name code that already has an order, as one ordered again, is no pending code
  if (c.ownerCode && !store.orders().some((o) => o.ownerCode === c.ownerCode)) store.addPending({ ownerCode: c.ownerCode, label: c.label, tld: c.chain.tld, createdAt: new Date().toISOString() })
  if (!isRedraw() || shown === null || state.checkout.label !== c.label) {
    state = initialState(c, step)
    shown = null
  }
  pageRoute = currentRoute()
  // a wait met elsewhere in the tab holds this page's actions too
  dispatch({ type: "opened", step, checkout: c, sending: session.isSending(c), waiting: waitingCardOrder(), hold: tabHold() })
  if (step !== "review") return
  const reads = new AbortController()
  whenLeaving(() => reads.abort())
  if (state.waiting) void settleWaiting(state.waiting, reads.signal)
  else void showOpenOrder(reads.signal)
  if (c.balance) void watchBalance(c.balance.source, reads.signal)
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((done) => {
  after(Math.max(0, ms), done, signal)
  signal.addEventListener("abort", () => done(), { once: true })
})

// The balance as its order reads now, in the tab and on the review. While an invoice holds it, Pay waits: the holder,
// as the code's find names it, is followed until its invoice closes; else the balance is read again when the hold can
// end, or after a pause while the holder's payment is confirming. Reads are never closer than the minimum.
async function watchBalance(source: string, signal: AbortSignal): Promise<void> {
  let holder: store.OrderRecord | null = null
  while (!signal.aborted) {
    const readAt = Date.now()
    let balance: api.Balance | null
    try {
      balance = (await api.readRegistration(source, undefined, signal)).balance
    } catch (e) {
      await pause(api.retryDelay(e, RETRY_MS) ?? RETRY_MS, signal)
      continue
    }
    if (signal.aborted) return
    session.updateActiveBalance(source, session.appliedBalance(source, balance))
    if (!act({ type: "balance-read", balance }) || !balanceHeld(state.checkout)) return
    const paying = store.orderByRegistration(source)
    holder ??= paying ? await flow.balanceHolder(paying).catch(() => null) : null
    if (signal.aborted) return
    const seen = holder && { label: holder.label, tld: holder.tld, url: store.orderUrl(holder) }
    if (JSON.stringify(seen) !== JSON.stringify(state.holder)) dispatch({ type: "holder-seen", holder: seen })
    const followed = holder?.invoiceId != null
    if (followed) await follow(holder!.invoiceId!, signal, (read) => read?.status === "open")
    // a holder whose invoice closed may be followed by another, which find names on the next turn
    if (followed) holder = null
    await pause(holdWait(state.checkout.balance?.heldUntil ?? null, followed, readAt, Date.now()), signal)
  }
}

function dispatch(event: CheckoutEvent): void {
  state = reduce(state, event)
  if (!isRoute(pageRoute)) return
  const kind = screenOf(state)
  shown = kind
  draw(kind, (signal) => asStep(BUILDERS[kind](state, signal)))
}

const holdEnds = (signal: AbortSignal) => holdEnder(signal, () => dispatch({ type: "hold-ended" }))

// A change is written to the tab's checkout before the page takes it; false, changing nothing, once the tab moved to another checkout.
function act(event: CheckoutEvent, apply: (event: CheckoutEvent) => void = dispatch): boolean {
  const change = changeOf(state, event)
  if (change && !session.updateCheckout(state.checkout.label, change)) return false
  apply(event)
  return true
}

const hasLinks = (c: session.Checkout) => Boolean(c.contact || c.channel)
// a link typed is shown by its own field, so the page takes it without drawing, unless the step's actions change with it
const setLink = (kind: LinkKind, link: string) => {
  const event: CheckoutEvent = { type: "link-set", kind, link }
  const turns = hasLinks(reduce(state, event).checkout) !== hasLinks(state.checkout)
  act(event, turns ? dispatch : (e) => { state = reduce(state, e) })
}

// Follows an invoice, each answer once it moves on from the one seen, while `followed` returns true; an invoice the service forgot is null.
async function follow(invoiceId: string, signal: AbortSignal, followed: (seen: api.InvoiceView | null) => boolean, seen?: api.InvoiceView): Promise<void> {
  while (!signal.aborted) {
    try {
      seen = await api.readInvoice(invoiceId, seen && api.seenOf(seen), signal)
    } catch (e) {
      // the service forgets an unpaid invoice some time after it closes; other errors are waited out
      if (e instanceof api.ApiError && e.code === "not_found") return void followed(null)
      if (signal.aborted) return
      await new Promise((r) => setTimeout(r, e instanceof api.ApiError && e.retryAfter ? e.retryAfter * 1000 : RETRY_MS))
      continue
    }
    if (!followed(seen)) return
  }
}

// The card order blocks a second one only while its invoice is open, so checkout follows it and opens up when it settles or closes.
const settleWaiting = (waiting: WaitingOrder, signal: AbortSignal) => follow(waiting.invoiceId, signal, (seen) => seen?.status === "open" || settled(waiting, signal))

function settled(waiting: WaitingOrder, signal: AbortSignal): false {
  store.updateOrder(waiting.registrationId, { cardSubmittedAt: undefined })
  store.clearCardSubmitted(waiting.invoiceId)
  if (signal.aborted) return false
  dispatch({ type: "waiting-settled" })
  void showOpenOrder(signal)
  return false
}

const OPEN_ORDER_LOOKBACK = 5
const unpaid = (i: api.InvoiceView | null): i is api.InvoiceView => i?.status === "open" && i.registration.phase === "unpaid"

// An unpaid invoice this browser made is pointed at, not blocking a new order, and followed until paid or closed; only the newest few are asked.
async function showOpenOrder(signal: AbortSignal): Promise<void> {
  const recent = store.orders().filter((o) => o.invoiceId && !o.cancelled && !o.replacedBy).slice(0, OPEN_ORDER_LOOKBACK)
  const invoices = await Promise.all(recent.map((o) => api.readInvoice(o.invoiceId!).catch(() => null)))
  const open = invoices.find(unpaid)
  if (!open || signal.aborted) return
  const show = (seen: api.InvoiceView | null) => {
    const order = unpaid(seen) ? { invoiceId: open.invoiceId, confirming: seen.paidInFull === true } : null
    if (!signal.aborted && JSON.stringify(order) !== JSON.stringify(state.openOrder)) dispatch({ type: "open-order-seen", order })
    return order !== null
  }
  show(open)
  void follow(open.invoiceId, signal, show, open)
}

const row = (what: string, value: Node | string, cls?: string) => el("div", { class: `trow${cls ? ` ${cls}` : ""}` }, el("span", {}, what), el("span", {}, value))

// The order as the search answered it, with the chats its links open, over its term, with the free days before it
// starts, its end, and what it costs; a name registered with a code costs nothing. Paid from a balance, its price takes
// the chats' place and the table ends with what the balance pays and the rest.
function orderCard(c: session.Checkout): HTMLElement {
  const y = years(c)
  const now = api.serviceNow() / 1000
  const name = `${c.label}.${c.chain.tld}`
  const chats = api.LINK_KINDS.filter((kind) => c[kind]).map((kind) => linkChat(c[kind], kind, name, `chat-${kind}`))
  const { fromBalance, rest } = split(c)
  const side = c.balance ? el("b", { class: "price" }, dollars(c.price)) : chats.length ? el("span", { class: "chats" }, chats) : null
  return el("section", { class: "card order" },
    el("div", { class: "row" }, nameTitle(c.label, "name", c.chain.tld), side),
    el("div", { class: "table" },
      row("Term", termOf(y, freeDays(c.termStart, now))),
      row("Registered until", dateOf(termEnd(y, c.termStart, now))),
      c.code ? el("div", { class: "trow total" }, el("span", {}, "Free SimpleX name"))
        : c.balance ? [row("From your balance", `\u2212${dollars(fromBalance)}`), row("To pay", dollars(rest), "total")]
        : row("Total", dollars(c.price), "total")))
}

// The order whose invoice holds the balance, named and linked once find names it, and how long it holds it; else how the
// balance changed since the search showed it.
function balanceChangeLine(s: CheckoutState): HTMLElement | null {
  const { checkout: c, holder } = s
  if (holder && heldForThisName(s)) {
    return line("warn", "wallet", "Your order for ", el("a", { href: holder.url }, nameText(holder.label, holder.tld)), ` holds your balance ${heldWords(c.balance!.heldUntil)}.`,
      ` Press ${payLabel(c)} to open it.`)
  }
  if (c.balance?.held) {
    return line("warn", "wallet", "Your balance is in use by ", holder ? el("a", { href: holder.url }, nameText(holder.label, holder.tld)) : "another order",
      ` ${heldWords(c.balance.heldUntil)}.`)
  }
  switch (c.balanceChange) {
    case undefined: return null
    case "gone": return line("warn", "wallet", "Your balance was spent or refunded meanwhile, so you pay the whole price.")
    case "changed": return line("warn", "wallet", `Your balance changed to ${dollars(c.balance!.amount)} meanwhile. Check what is left to pay.`)
  }
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
    methodMark(m), el("b", {}, methodName(m)))
  })
  return el("section", { class: "pay-with" },
    order ? el("p", { class: "note other-order" }, `Another order ${order.confirming ? "is confirming its payment" : "is waiting for its payment"}. `,
      el("a", { class: "nowrap", href: store.invoiceUrl(order.invoiceId) }, "Open that order")) : null,
    c.unavailable ? line("warn", "alert", `${methodName(c.unavailable)} is temporarily unavailable. Try another method, or come back later.`) : null,
    el("div", { class: "methods", role: "radiogroup", "aria-label": "Pay with" }, ...radios))
}

const waitingNotice = (blocked: WaitingOrder) => el("section", { class: "pay-with" },
  alertBox("info", "info", "You have an order waiting to be confirmed", "A second order would be a second charge, so this one cannot start yet. When that payment is confirmed or expires, you can start a new one here."),
  el("div", {}, btn("Open the waiting order", "quiet", () => go(store.invoiceUrl(blocked.invoiceId)))))

const actionLabel = (text: string, s: CheckoutState) => s.sending && !s.busy ? "Sending your order…" : text

function payButton(s: CheckoutState, blocked: boolean): HTMLButtonElement {
  const pay = btn(actionLabel(payLabel(s.checkout), s), "", () => void submitOrder())
  pay.dataset.focus = "pay"
  return setAction(pay, s.busy, blocked || s.sending || s.hold !== null || !s.checkout.agreed || payWaits(s))
}

// every order waits for the buyer to agree to the name terms; the terms open beside the order
function termsBox(s: CheckoutState): HTMLElement {
  const box = el("input", { type: "checkbox", checked: s.checkout.agreed, disabled: s.sending, "data-focus": "agreed" })
  box.addEventListener("change", () => { if (!state.sending && !act({ type: "agreed", agreed: box.checked })) refresh() })
  return el("div", { class: "mid" }, el("label", { class: "check terms" }, box, el("span", { class: "box" }),
    el("span", {}, "I agree to ", el("a", { class: "nowrap", href: TERMS_URL, target: "_blank", rel: "noopener" }, "SimpleX name terms"),
      " and do not knowingly violate any trademarks.")))
}

function payNote(s: CheckoutState, blocked: boolean, signal: AbortSignal): HTMLElement {
  const held = !blocked && !s.sending ? s.hold : null
  holdEnds(signal)(s.hold !== null)
  return keptLive(CHECKOUT_NOTE, undefined, held && holdNotice(held, signal))
}

function continueButton(onclick: () => void, held = false): HTMLButtonElement {
  const next = setAction(btn("Continue", "", onclick), false, held)
  next.dataset.focus = "continue"
  return next
}

// a link refused or being checked takes focus; until the code is saved, the review opens the name code step instead
const linksDone = (fields: HTMLElement[]) => { if (!focusUnsettled(fields)) go(checkoutUrl("review")) }

function buildLinks(s: CheckoutState): HTMLElement {
  const c = s.checkout
  const links = kept("links", () => linkFieldsFor({ contact: c.contact, channel: c.channel }, setLink))
  locked(links.node, s.sending)
  // Continue needs a link; without one the step goes on by Skip for now
  const linked = hasLinks(c)
  const skip = linked ? null : link("Skip for now", () => go(checkoutUrl("review")))
  skip?.setAttribute("data-focus", "skip")
  return screen({ title: "What should your name open?", back: searchLink(c.label),
    lead: ["Paste your SimpleX contact address or channel link. ", el("span", { class: "nowrap" }, "You can change it later.")],
    alt: skip, action: continueButton(() => linksDone(links.fields()), !linked) },
    el("span", { class: "label" }, "Link"), links.node)
}

function buildCode(s: CheckoutState): HTMLElement {
  const c = s.checkout
  const box = el("input", { type: "checkbox", checked: c.saved, disabled: s.sending, "data-focus": "saved" })
  box.addEventListener("change", () => { if (!state.sending && !act({ type: "saved", saved: box.checked })) refresh() })
  return screen({ title: "Save your name code", lead: ["It is the only key to ", nameText(c.label, c.chain.tld, "."), " If you lose it, nothing can recover it."], back: checkoutUrl("links"),
    action: continueButton(() => go(checkoutUrl("review")), !c.saved) },
    codeDisplay(c.ownerCode!, "owner-code", true),
    store.canPersist() ? el("p", { class: "note center" }, "Private windows and Tor Browser forget it when closed.")
      : alertBox("danger", "alert", "This code could not be saved in this browser", "Save a copy now: it will be the only one."),
    el("label", { class: "check" }, box, el("span", { class: "box" }), SAVED_LABEL))
}

function buildReview(s: CheckoutState, signal: AbortSignal): HTMLElement {
  const c = s.checkout
  const blocked = blockedBy(s)
  // the other way to pay ends the note under the methods
  const eth = el("a", { class: "nowrap", href: DAPP_URL, target: "_blank", rel: "noopener" }, "Pay with ETH")
  return screen({ title: "Check your order", back: checkoutUrl("code"), action: payButton(s, blocked !== null) },
    el("div", { class: "review" }, orderCard(c),
      c.codeError ? line("bad", "alert", `${c.codeError} Pay for the name here, or check another code.`) : null,
      balanceChangeLine(s),
      c.code || covered(c) ? null : blocked ? waitingNotice(blocked) : methodsBlock(s),
      c.code || covered(c) || blocked ? null : el("div", { class: "notes" }, el("p", {}, `After paying, keep this page open, or reopen its link within ${REVEAL_HOURS} hours. `, eth))),
    payNote(s, blocked !== null, signal),
    termsBox(s))
}

function buildPriceChanged({ checkout: c }: CheckoutState): HTMLElement {
  return outcome({ tone: "warn", icon: "alert", title: "The price changed",
    text: [nameText(c.label, c.chain.tld), ` costs ${dollars(c.price)} now; it changed while you were deciding. Nothing was charged.`],
    action: btn("Search again", "", () => go(searchLink(c.label))) })
}

function buildTooMany({ checkout: c, hold }: CheckoutState, signal: AbortSignal): HTMLElement {
  holdEnds(signal)(hold !== null)
  return limitScreen(hold, refresh, searchLink(c.label), signal)
}

function buildTaken({ checkout: c }: CheckoutState): HTMLElement {
  return outcome({ tone: "info", icon: "info", title: "This name is no longer available", text: [nameText(c.label, c.chain.tld), " became unavailable after you searched for it. Nothing was charged."],
    action: btn("Search another name", "", () => go(searchLink(""))) })
}

function buildFailed(s: CheckoutState): HTMLElement {
  const c = s.checkout
  // the same order is sent again from here; Back leaves it for the search
  const retry = setAction(btn("Try again", "", () => void submitOrder()), s.busy, false)
  return outcome({ tone: "danger", icon: "alert", title: "That did not go through", text: "Nothing was charged. If this happens again, get in touch.",
    action: retry, alt: link("Back", () => go(searchLink(c.label))) })
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
  if (!c.code && !covered(c) && waitingCardOrder()) return refresh()
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
  // a balance pays under its order's name code; one whose order this browser no longer keeps pays nothing
  const source = c.balance && store.orderByRegistration(c.balance.source)
  if (c.balance && !source) return balanceChanged(c, null)
  dispatch({ type: "send-started" })
  const links = { contact: c.contact, channel: c.channel }
  const draft: flow.Draft = source ? flow.spendDraft(source, c.label, links, { ...c.chain, price: c.price, years: years(c), termStart: c.termStart })
    : { label: c.label, links, chain: c.chain, years: years(c), termStart: c.termStart, ownerCode: c.ownerCode! }
  // The order is kept whatever the buyer did meanwhile. Its checkout ends, and the order opens, only while this checkout
  // is still the tab's: the buyer may have started another name, by Back and Forward too.
  const mine = currentRoute()
  const search = searchLink(c.label)
  const done = (url: string) => {
    const current = session.checkout()
    const ours = current?.label === c.label && current.ownerCode === c.ownerCode
    if (ours) session.setCheckout(null)
    if (!isRoute(mine) && !(ours && location.hash.startsWith("#/checkout"))) return
    // Back from the order returns once to its search, past the checkout that has ended
    if (location.hash.startsWith("#/checkout")) goFrom(c.searchAt, search, url)
    else go(url)
  }
  const chosen = c.code ? "code" : covered(c) ? "balance" : c.method
  const of = JSON.stringify([draft, c.code?.display ?? c.method, c.price, c.balance && [c.balance.source, c.balance.amount]])
  try {
    // a spend that reached the service, as its order holding the balance shows, is sent again as it was, however old
    const fresh = c.sent?.of === of && (api.serviceNow() / 1000 - c.sent.request.timestamp < SIGNED_WINDOW_S || (c.sent.spend !== undefined && heldForThisName(state)))
    const built = fresh ? c.sent! : { of, ...await (source ? flow.spendRequest(source, draft, c.price, c.balance!.amount, c.method) : flow.orderRequest(draft)) }
    session.updateCheckout(c.label, { sent: built })
    try {
      if (source) {
        // a spend's `of` names its balance, so the order kept for it holds the spend
        const next = await flow.sendSpend(source, draft, { request: built.request, owner: built.owner, spend: built.spend! })
        // the balance is spent, or held by the new order's invoice, so it pays for nothing more in this tab
        session.updateActiveBalance(source.registrationId, null)
        return done(store.orderUrl(next))
      }
      if (c.code) {
        const res = await api.registerWithCode(built.request, c.code.display)
        // the code is the order's now, so it pays for nothing more in this tab
        session.dropActiveCode(c.code.display)
        store.saveOrder({ ...flow.recordFor(draft, built, "code", 0, { registrationId: res.registrationId, invoiceId: null }), prepaidCode: c.code.display })
        return done(store.orderUrl({ invoiceId: null, registrationId: res.registrationId }))
      }
      const res = await api.createOrder(built.request, c.method, c.price)
      const { method, paid } = flow.paidWith(res)
      store.saveOrder(flow.recordFor(draft, built, method, paid, { registrationId: res.registration.id, invoiceId: res.invoiceId }))
      done(store.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id }))
    } catch (e) {
      if (!(e instanceof api.ApiError && e.code === "order_exists")) throw e
      // this name code already has a live order for the name, which it opens instead
      const own = await flow.ownOrderFor(c.ownerCode!, built.request.labelHash)
      if (!own) throw e
      if (own.invoiceId && own.method !== chosen) openedInstead({ invoiceId: own.invoiceId, had: own.method, chosen })
      done(store.orderUrl(own))
    }
  } catch (e) {
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

// the balance as the service has it now, in the tab and on the review
function balanceChanged(c: session.Checkout, balance: api.Balance | null): void {
  if (c.balance) session.updateActiveBalance(c.balance.source, session.appliedBalance(c.balance.source, balance))
  act({ type: "balance-changed", balance })
  // the review opened again follows the invoice that holds it
  if (balanceHeld(state.checkout)) refresh()
}

function orderError(e: unknown, c: session.Checkout): void {
  if (e instanceof api.BalanceChanged) return balanceChanged(c, e.balance)
  const code = e instanceof api.ApiError ? e.code : "network"
  if (code === "name_taken") {
    // no order was made, so the name code made for it owns nothing to find later
    if (c.ownerCode) store.dropPending(c.ownerCode)
    return void act({ type: "order-refused", reason: "taken" })
  }
  if (code in CODE_ERRORS) {
    // a code the service will not take pays for nothing more in this tab
    if (c.code) session.dropActiveCode(c.code.display)
    return void act({ type: "order-refused", reason: "code", error: CODE_ERRORS[code] })
  }
  if (code === "provider_unavailable") return void act({ type: "order-refused", reason: "method" })
  if (code === "catalog_changed" && e instanceof api.ApiError && typeof e.body.price === "number") return void act({ type: "price-changed", price: e.body.price })
  // the tab's wait started as the order was refused; the page holds for what is left of it
  if (code === "rate_limited") return dispatch({ type: "hold-started", until: holdEnd() })
  dispatch({ type: "order-refused", reason: "failed" })
}
