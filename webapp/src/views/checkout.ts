// Checkout on one page: the order, its optional links, how it pays or the code that pays it, the name code, and Pay.
import * as api from "../api.ts"
import { alertBox, btn, codeDisplay, el, icon, type Kid, nameText, nameTitle, setAction, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { dateOf, dollars, methodName, shortAddress, termText, untilFromNow } from "../format.ts"
import { type Method, methodMark } from "../icons.ts"
import { type LinkKind, linkKind, linkProblem, PRICED_YEARS, priceFor } from "../names.ts"
import { changeOf, type CheckoutEvent, type CheckoutKind, type CheckoutState, initialState, reduce, screenOf, type WaitingOrder } from "../screens/checkout.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { CODE_ERRORS, codeField, type CodeVerdict, refuseCode } from "./codes.ts"
import { entityCard } from "./search.ts"
import { type Builder, currentRoute, draw, focusOn, go, isRedraw, isRoute, kept, keptLive, limitScreen, outcome, redirect, refresh, screen, searchLink, whenDropped, whenLeaving } from "./shell.ts"
import { holdEnd, holdEnder, holdFrom, holding, holdNotice, tabHold } from "./hold.ts"
import { CHECKOUT_STEP } from "./track.ts"

const METHOD_ORDER: Method[] = ["card", "btc", "xmr"]
const METHODS: Record<Method, string> = { card: "Processed by Stripe", btc: "On-chain", xmr: "Private by default" }
const CODE_FIELD = "checkout-code"
const CODE_LABEL = "I have a code"
const CHECKOUT_NOTE = "checkout-note"
const SAVED_LABEL = "I have saved my name code"

const years = (c: session.Checkout) => c.code?.years ?? PRICED_YEARS
// a card order waiting for Stripe holds a second paid order; a code pays nothing, so it holds none
const blockedBy = ({ checkout, waiting }: CheckoutState) => checkout.code ? null : waiting
const payLabel = (c: session.Checkout) => c.code ? "Register" : c.appOwner ? "Continue" : `Pay ${dollars(c.price, true)} with ${methodName(c.method)}`

function waitingCardOrder(): WaitingOrder | null {
  const order = store.orders().find((o) => o.method === "card" && o.cardSubmittedAt && o.invoiceId)
  return order ? { registrationId: order.registrationId, invoiceId: order.invoiceId! } : null
}

// The checkout on screen, kept over a redraw of the same page: what the page knows and the screen it shows.
let state: CheckoutState
let shown: CheckoutKind | null = null
// the route the checkout's page was last drawn on; once it is no longer the route, the page has been left
let pageRoute = -1

// The name code is made as the checkout opens and kept as pending, so Your names lists it before any order exists.
export function checkoutPage(): void {
  const stored = session.checkout()
  if (!stored) return redirect("/#/")
  if (!stored.appOwner && !stored.ownerCode) session.setCheckout({ ...stored, ownerCode: flow.newOwnerCode() })
  const c = session.checkout()!
  if (c.ownerCode) store.addPending({ ownerCode: c.ownerCode, label: c.label, tld: c.chain.tld, createdAt: new Date().toISOString() })
  if (!isRedraw() || shown === null || state.checkout.label !== c.label) {
    state = initialState(c)
    shown = null
  }
  pageRoute = currentRoute()
  // a wait met elsewhere in the tab holds this page's actions too
  dispatch({ type: "opened", checkout: c, sending: session.isSending(c), waiting: waitingCardOrder(), hold: tabHold() })
  const reads = new AbortController()
  whenLeaving(() => reads.abort())
  if (state.waiting) void settleWaiting(state.waiting, reads.signal)
  else void showOpenOrder(reads.signal)
}

// Every change of the checkout comes here as an event: the state takes it, and the screen follows the state.
function dispatch(event: CheckoutEvent): void {
  state = reduce(state, event)
  // a page left draws nothing
  if (!isRoute(pageRoute)) return
  const kind = screenOf(state)
  shown = kind
  draw(kind, (signal) => BUILDERS[kind](state, signal), CHECKOUT_STEP)
}

// a screen that holds an action for the tab's wait hears when it is over
const holdEnds = (signal: AbortSignal) => holdEnder(signal, () => dispatch({ type: "hold-ended" }))

// A change of the order is written to the tab's checkout before the page takes it; a page whose checkout the tab has
// moved on from changes nothing. False when it did not take it.
function act(event: CheckoutEvent, take: (event: CheckoutEvent) => void = dispatch): boolean {
  const change = changeOf(state, event)
  if (change && !session.updateCheckout(state.checkout.label, change)) return false
  take(event)
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
// a link preview with no answer is asked again after this long
const PREVIEW_RETRY_S = 3

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

const heading = (text: string, ...extra: Kid[]) => el("div", { class: "sec-title" }, el("h2", {}, text), ...extra)

function summaryCard(c: session.Checkout, blocked: boolean): HTMLElement {
  const rows: [string, string][] = [["Term", termText(years(c))], ["Registered until", `about ${dateOf(untilFromNow(years(c)), true)}`]]
  // a checkout held by a waiting card order does not say how it pays yet
  if (!c.code && !blocked) rows.push(["Paying with", methodName(c.method)])
  return el("section", { class: "card summary-card" }, nameTitle(c.label, "name", c.chain.tld),
    el("div", { class: "rows" }, ...rows.map(([label, text]) => el("div", { class: "row" }, el("span", {}, label), el("b", {}, text)))),
    el("div", { class: "total" }, el("span", {}, "Total"),
      el("span", {}, ...(c.code ? [el("s", {}, dollars(priceFor(c.price, years(c)), true)), "$0.00"] : [dollars(c.price, true)]))))
}

// an order on its way is sent as it is: its links, method and code stay as they are until it is answered
function locked<T extends HTMLElement>(node: T, sending: boolean): T {
  for (const input of node.querySelectorAll("input")) input.disabled = sending
  return node
}

// the link fields are kept through every change of the page, with what is typed and any preview still loading
function linksBlock({ checkout: c, sending }: CheckoutState): HTMLElement {
  return el("section", { class: "links" },
    heading("Point it at your SimpleX", el("span", { class: "opt" }, "Optional")),
    el("p", { class: "sec-note" }, "Set in the same registration. You can change them later."),
    locked(kept("link-contact", () => linkField("contact", "Paste your address", "Address", c.contact, (link) => setLink("contact", link))), sending),
    locked(kept("link-channel", () => linkField("channel", "Paste your channel", "Channel", c.channel, (link) => setLink("channel", link))), sending))
}

function chooseMethod(m: Method): void {
  if (state.sending || m === state.checkout.unavailable || !act({ type: "method-chosen", method: m })) return
  focusOn(`method-${m}`)
}

// The payment methods as one radio group, with a note of a method refused and of an unpaid invoice above them.
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
    methodMark(m), el("b", {}, methodName(m)), el("span", {}, off ? "Temporarily unavailable" : METHODS[m]))
  })
  return el("section", { class: "pay-with" }, heading("Payment method"),
    order ? alertBox("info", "clock", `${order.label}.${order.tld} ${order.confirming ? "is confirming its payment" : "is waiting for its payment"}`,
      el("a", { href: store.invoiceUrl(order.invoiceId) }, "Open that order")) : null,
    c.unavailable ? alertBox("warn", "alert", `${methodName(c.unavailable)} is temporarily unavailable`, "Try another method, or come back later.") : null,
    el("p", { class: "sec-note" }, "You pay on the next page."),
    el("div", { class: "methods", role: "radiogroup", "aria-label": "Payment method" }, ...radios))
}

const coveredLine = (code: session.AppliedCode) => el("section", { class: "pay-with" }, heading("Payment"),
  alertBox("ok", "check", "Paid with your code", `Registered for ${termText(code.years)}, with nothing to pay.`))

const waitingNotice = (blocked: WaitingOrder) => el("section", { class: "pay-with" }, heading("Payment method"),
  alertBox("info", "info", "You have an order waiting to be confirmed", "A second order would be a second charge, so this one cannot start yet. When that payment is confirmed or expires, you can start a new one here."),
  el("div", {}, btn("Open the waiting order", "quiet", () => go(store.invoiceUrl(blocked.invoiceId)))))

// A code that pays is applied as it is judged, one for longer names is refused here, and anything else takes off the
// code the field held. Read from the module's state, as the field is kept across draws.
function onVerdict(v: CodeVerdict | null): string | null {
  const { label, code, codeError } = state.checkout
  const tooShort = v?.ok === true && label.length < v.code.minLength
  if (v?.ok && !tooShort) act({ type: "code-applied", code: v.code })
  // an edit takes off the code the field held, and the service's last refusal of one
  else if (code || codeError) act({ type: "code-removed" })
  return v?.ok && tooShort ? `This code covers names of ${v.code.minLength} or more letters; ${label} has ${label.length}.` : null
}

const codeEntry = () => codeField(CODE_FIELD, CODE_LABEL, onVerdict, state.checkout.code, state.checkout.codeError ?? null)

function nameCodeBlock(c: session.Checkout): HTMLElement {
  const box = el("input", { type: "checkbox", checked: c.saved, "data-focus": "saved" })
  box.addEventListener("change", () => { if (!act({ type: "saved", saved: box.checked })) redirect("/#/names") })
  return el("section", { class: "card name-code" }, heading("Your name code"),
    el("p", { class: "sec-note" }, "It will own ", nameText(c.label, c.chain.tld, "."), " If you lose it, nothing else can recover the name. Copy it somewhere safe or write it down. You redeem it in the app later."),
    codeDisplay(c.ownerCode!, "owner-code"),
    el("label", { class: "check" }, box, el("span", { class: "box" }), SAVED_LABEL))
}

// a page drawn while its order is on its way says so on its button
const actionLabel = (text: string, s: CheckoutState) => s.sending && !s.busy ? "Sending your order…" : text

function payBlock(s: CheckoutState, blocked: boolean, links: HTMLElement | null, signal: AbortSignal): HTMLElement {
  const c = s.checkout
  const fromApp = c.appOwner !== null
  const pay = btn(actionLabel(payLabel(c), s), "block", () => {
    // a link still checked or refused takes focus rather than leaving with the order
    const pending = [...links?.querySelectorAll<HTMLElement>(".link-field") ?? []].find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
    if (pending) return pending.querySelector("input")!.focus()
    void submitOrder()
  }, icon("arrow"))
  pay.dataset.focus = "pay"
  setAction(pay, s.busy, (!fromApp && !c.saved) || blocked || s.sending || s.hold !== null)
  const held = !blocked && !s.sending ? s.hold : null
  holdEnds(signal)(s.hold !== null)
  return el("div", { class: "pay-block" }, pay, keptLive(CHECKOUT_NOTE, undefined, held && holdNotice(held, signal)),
    el("p", { class: "fine" }, icon("shield"), fromApp
      ? el("span", {}, "Registered to your app's wallet, ", el("span", { class: "nowrap" }, shortAddress(c.appOwner!)), ".")
      : "Registered to a wallet made in this browser; nobody else holds its key."))
}

function storageWarning(fromApp: boolean): HTMLElement | null {
  if (store.canPersist()) return null
  return fromApp
    ? alertBox("warn", "alert", "This browser will not keep this order", "Keep this page open until the name is registered; a reload loses it.")
    : alertBox("warn", "alert", "This browser will not keep your name code", "Your saved copy will be the only one.")
}

function buildCheckout(s: CheckoutState, signal: AbortSignal): HTMLElement {
  const c = s.checkout
  const fromApp = c.appOwner !== null
  const blocked = blockedBy(s)
  const links = fromApp ? null : linksBlock(s)
  return screen({ title: "Check your order", back: searchLink(c.label, c.appOwner) },
    storageWarning(fromApp),
    summaryCard(c, blocked !== null),
    links,
    c.code ? coveredLine(c.code) : blocked ? waitingNotice(blocked) : methodsBlock(s),
    fromApp ? null : locked(codeEntry(), s.sending),
    fromApp ? null : nameCodeBlock(c),
    payBlock(s, blocked !== null, links, signal))
}

function buildPriceChanged({ checkout: c }: CheckoutState): HTMLElement {
  return outcome({ tone: "warn", icon: "alert", title: "The price changed",
    text: [nameText(c.label, c.chain.tld), ` costs ${dollars(c.price, true)} now; it changed while you were deciding. Nothing was charged.`],
    action: btn("Search again", "", () => go(searchLink(c.label, c.appOwner))) })
}

// Try again draws the checkout the order was sent from again
function buildTooMany({ checkout: c, hold }: CheckoutState, signal: AbortSignal): HTMLElement {
  holdEnds(signal)(hold !== null)
  return limitScreen(hold, refresh, searchLink(c.label, c.appOwner), signal)
}

function buildFailed(s: CheckoutState): HTMLElement {
  const c = s.checkout
  // the same order is sent again from here; Back leaves it for the search
  const retry = setAction(btn("Try again", "", () => void submitOrder()), s.busy, false)
  return outcome({ tone: "danger", icon: "alert", title: "That did not go through", text: "Nothing was charged. If this happens again, get in touch.",
    action: el("div", { class: "actions" }, retry, btn("Back", "quiet", () => go(searchLink(c.label, c.appOwner)))) })
}

const BUILDERS: Record<CheckoutKind, Builder<CheckoutState>> = {
  checkout: buildCheckout,
  "status:price-changed": buildPriceChanged,
  "status:too-many": buildTooMany,
  "status:failed": buildFailed,
}

// The field's data-state says whether its link is "ok", "bad", or "empty"; save gets the link only when it is ok.
let linkFields = 0
type Preview = Awaited<ReturnType<typeof api.previewLink>>
// a link's profile as shown, so a field drawn again for it, as a step gone back to, shows it at once
const previews = new Map<string, Preview>()

export function linkField(kind: LinkKind, placeholder: string, label: string, value: string, save: (v: string) => void): HTMLElement {
  const errorId = `link-error-${++linkFields}`
  const input = el("input", { type: "text", placeholder, value, "aria-label": label, spellcheck: "false", autocomplete: "off" })
  const box = el("div", { class: "input" }, icon("link"), input, el("span", { class: "kind" }, label))
  const card = el("div", {})
  const field = el("div", { class: "link-field" }, box, card)
  // the field lives as long as the route keeps it; a check started anew ends the last one's wait
  const life = new AbortController()
  whenDropped(() => life.abort())
  const shown = () => !life.signal.aborted
  let waiting = new AbortController()
  let seq = 0
  // the card's place is held while the link is checked, so the page is laid out at its height from the start
  const holdCardPlace = () => {
    if (!card.querySelector(".skeleton")) card.replaceChildren(el("div", { class: "entity-wrap", "aria-hidden": "true" }, el("div", { class: "entity skeleton" })))
  }
  const refuse = (text: string) => {
    box.className = "input bad"
    field.dataset.state = "bad"
    input.setAttribute("aria-invalid", "true")
    input.setAttribute("aria-describedby", errorId)
    // the same refusal again, as typing on in a refused link gives, keeps still
    if (card.querySelector(".field-error")?.textContent !== text) card.replaceChildren(el("p", { class: "field-error", id: errorId }, icon("alert"), text))
  }
  const check = async () => {
    const mine = ++seq
    waiting.abort()
    waiting = new AbortController()
    const link = input.value.trim()
    save("")
    box.className = "input"
    input.removeAttribute("aria-invalid")
    input.removeAttribute("aria-describedby")
    field.dataset.state = link ? "checking" : "empty"
    if (!link) return card.replaceChildren()
    const entity = (profile: Preview) => el("div", { class: "entity-wrap" }, entityCard({ ...profile, link }, false))
    const accept = () => {
      field.dataset.state = "ok"
      box.className = "input ok"
      save(link)
    }
    const known = previews.get(link)
    // The value the field opened with, or one the page gave it since, as the chain has it, is kept as it is, even several
    // links set elsewhere or one whose preview fails.
    const kept = field.dataset.kept ?? value
    if (link === kept) {
      accept()
      if (kept.includes(";")) return card.replaceChildren(el("p", { class: "sec-note mt-8" }, "Several links. SimpleX opens the first one."))
      if (known) return card.replaceChildren(entity(known))
      holdCardPlace()
      const profile = await api.previewLink(link).catch(() => null)
      if (profile) previews.set(link, profile)
      if (mine === seq && shown() && field.isConnected) card.replaceChildren(profile ? entity(profile) : "")
      return
    }
    const problem = linkProblem(kind, link)
    if (problem) {
      const other = linkKind(link)
      return refuse(problem === "long" ? "This link is too long."
        : other ? `This is a ${other === "contact" ? "contact address" : "channel"} link: paste it in the ${other === "contact" ? "Address" : "Channel"} field.`
        : `Paste a SimpleX ${kind === "contact" ? "contact address" : "channel"} short link.`)
    }
    if (known) {
      accept()
      return card.replaceChildren(entity(known))
    }
    holdCardPlace()
    try {
      const profile = await api.previewLink(link)
      previews.set(link, profile)
      if (mine !== seq || !shown() || !field.isConnected) return
      accept()
      card.replaceChildren(entity(profile))
    } catch (e) {
      if (mine !== seq || !shown() || !field.isConnected) return
      // the service refusing the link is about the link; a rate limit or no answer is not, and the field checks again
      if (!(e instanceof api.ApiError) || e.code === "network" || e.code === "rate_limited" || e.status >= 500) {
        const line = el("span", {})
        const notice = el("p", { class: "field-error", id: errorId }, icon("clock"), line)
        input.setAttribute("aria-describedby", errorId)
        waitOut(line, e instanceof api.ApiError && e.retryAfter ? e.retryAfter : PREVIEW_RETRY_S,
          (left) => `The link could not be checked now. Checking again in ${left}.`, () => { if (mine === seq) void check() }, AbortSignal.any([life.signal, waiting.signal]))
        return card.replaceChildren(notice)
      }
      refuse("This link could not be opened.")
    }
  }
  input.addEventListener("input", () => void check())
  field.dataset.state = "empty"
  if (value) void check()
  return field
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
    const current = session.checkout()
    const ours = current?.label === c.label && current.ownerCode === c.ownerCode
    if (ours) session.setCheckout(null)
    if (!isRoute(mine) && !(ours && location.hash.startsWith("#/checkout"))) return
    // Back from the order returns to its search, still opened from the app, rather than to a checkout that has ended
    if (location.hash.startsWith("#/checkout")) history.replaceState(history.state, "", search)
    go(url)
  }
  let built: flow.BuiltOrder | null = null
  try {
    built = await flow.orderRequest(draft)
    if (c.code) {
      const res = await api.registerWithCode(built.request, c.code.display)
      if (res.invoiceId) return await openInvoice(draft, built, res.invoiceId, done)
      store.saveOrder({ ...flow.recordFor(draft, built, "code", 0, { registrationId: res.registrationId, invoiceId: null }), prepaidCode: c.code.display })
      return done(store.orderUrl({ invoiceId: null, registrationId: res.registrationId }))
    }
    const res = await api.createOrder(built.request, c.method, c.price)
    const { method, paid } = flow.paidWith(res)
    store.saveOrder(flow.recordFor(draft, built, method, paid, { registrationId: res.registration.id, invoiceId: res.invoiceId }))
    done(store.orderUrl({ invoiceId: res.invoiceId, registrationId: res.registration.id }))
  } catch (e) {
    if (built && e instanceof api.ApiError && e.code === "bad_request" && typeof e.body.invoiceId === "string") return openInvoice(draft, built, e.body.invoiceId, done)
    // the order did not go: its checkout is open to change again before the error page sends the buyer back to it
    session.stopSending(c)
    // a rate limit holds the tab's actions wherever the buyer has gone meanwhile
    holdFrom(e)
    // as on success: the error shows where the buyer still is in this checkout, by Back and Forward too
    const ours = session.checkout()?.label === c.label && session.checkout()?.ownerCode === c.ownerCode
    if (isRoute(mine) || (ours && location.hash.startsWith("#/checkout"))) orderError(e, c)
  }
}

// This commitment already has an order, so this browser's code owns it: its record is kept before it opens.
async function openInvoice(draft: flow.Draft, built: flow.BuiltOrder, invoiceId: string, done: (url: string) => void): Promise<void> {
  const invoice = await api.readInvoice(invoiceId).catch(() => null)
  if (invoice) store.saveOrder(flow.recordFor(draft, built, invoice.cryptoCurrency ?? "card", invoice.amount, { registrationId: invoice.registration.id, invoiceId }))
  done(store.invoiceUrl(invoiceId))
}

function orderError(e: unknown, c: session.Checkout): void {
  const code = e instanceof api.ApiError ? e.code : "network"
  if (code === "name_taken") {
    // no order was made, so the name code shown owns nothing to find later
    if (c.ownerCode) store.dropPending(c.ownerCode)
    return go(searchLink(c.label, c.appOwner))
  }
  if (code in CODE_ERRORS) {
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
