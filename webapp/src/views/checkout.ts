// Checkout: the links and the payment method (or a prepaid code), then the owner code, then the order.
import * as api from "../api.ts"
import { alertBox, btn, codeDisplay, el, icon, link, liveRegion, nameText, nameTitle, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import * as focus from "../focus.ts"
import { addTo, current, live, removeFrom, transitionsIdle } from "../motion.ts"
import { dateOf, dollars, methodName, seconds, shortAddress, termText, untilFromNow } from "../format.ts"
import { type Method, methodMark } from "../icons.ts"
import { type LinkKind, linkKind, linkProblem, PRICED_YEARS, priceFor } from "../names.ts"
import {
  changeOf, checkoutMachine, type CheckoutEvent, type CheckoutKind, type CheckoutPage, type CheckoutState, initialState, type WaitingOrder,
} from "../screens/checkout.ts"
import { headingFocus, step } from "../screens/machine.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { CODE_ERRORS, verdictNode, watchCode } from "./codes.ts"
import { entityCard } from "./search.ts"
import { type Build, type Built, crumbs, crumbsTo, currentRoute, go, INVEST_LINE, isRedraw, isRoute, pageHead, redirect, refresh, screens, searchLink, status, twoCols, WEFUNDER_URL, whenLeaving } from "./shell.ts"
import { every, oneAtATime } from "./effects.ts"
import { holdEnd, holdEnder, holdFrom, holding, tabHold } from "./hold.ts"
import { changeTo, drawAs, holdNotice, secondsLeft, setAction, unchanging } from "./slots.ts"

const METHOD_ORDER: Method[] = ["card", "btc", "xmr"]
const METHODS: Record<Method, string> = { card: "Processed by Stripe", btc: "On-chain", xmr: "Private by default" }

const codeStart = (code: session.AppliedCode) => `${code.display.slice(0, 9)}…`
const years = (c: session.Checkout) => c.code?.years ?? PRICED_YEARS
// a card order waiting for Stripe holds a second paid order; a code pays nothing, so it holds none
const blockedBy = ({ checkout, waiting }: CheckoutState) => checkout.code ? null : waiting

function waitingCardOrder(): WaitingOrder | null {
  const order = store.orders().find((o) => o.method === "card" && o.cardSubmittedAt && o.invoiceId)
  return order ? { registrationId: order.registrationId, invoiceId: order.invoiceId! } : null
}

// The checkout on screen, kept over a redraw of the same page: what the page knows and the screen it shows.
let state: CheckoutState
let shown: CheckoutKind | null = null
const showScreen = screens<CheckoutState>()
// the route the checkout's page was last drawn on; once it is no longer the route, the page has been left
let pageRoute = -1

export function checkoutPage(): void {
  const c = session.checkout()
  if (!c) return redirect("/#/")
  // an order on its way holds its checkout: on the code page when there is one, here for an order opened from the app
  if (session.isSending(c) && !c.appOwner) return redirect("/#/checkout/code")
  open("checkout", c)
}

export function ownerCodePage(): void {
  const c = session.checkout()
  if (!c || c.appOwner) return redirect("/#/checkout")
  if (!c.ownerCode) session.setCheckout({ ...c, ownerCode: flow.newOwnerCode() })
  const draft = session.checkout()!
  store.addPending({ ownerCode: draft.ownerCode!, label: c.label, tld: c.chain.tld, createdAt: new Date().toISOString() })
  open("owner-code", draft)
}

// The page opened, or drawn again, reads what the tab has stored; the reads it starts end when the page is left.
function open(page: CheckoutPage, c: session.Checkout): void {
  if (!isRedraw() || shown === null || state.page !== page || state.checkout.label !== c.label) {
    state = initialState(page, c)
    shown = null
  }
  pageRoute = currentRoute()
  // a wait met elsewhere in the tab holds this page's actions too
  dispatch({ type: "opened", checkout: c, sending: session.isSending(c), waiting: waitingCardOrder(), hold: tabHold() })
  if (page !== "checkout") return
  const reads = new AbortController()
  whenLeaving(() => reads.abort())
  if (state.waiting) void settleWaiting(state.waiting, reads.signal)
  else void showOpenOrder(reads.signal)
}

// Every change of the checkout's pages comes here as an event: the state takes it, and the screen follows the state.
const dispatch = oneAtATime((event: CheckoutEvent) => {
  const result = step(checkoutMachine, state, shown, event)
  state = result.state
  // a page left draws nothing
  if (!isRoute(pageRoute)) return
  const heading = headingFocus(result, shown, focus.onPage())
  shown = result.screen
  showScreen("search", result.screen, state, BUILDS[result.screen], heading, result.motion)
})

// a screen that holds an action for the tab's wait hears when it is over
const holdEnds = (signal: AbortSignal) => holdEnder(signal, () => dispatch({ type: "hold-ended" }))

// A change of the order is written to the tab's checkout before the page takes it; a page whose checkout the tab has
// moved on from changes nothing. False when it did not take it.
function act(event: CheckoutEvent): boolean {
  const change = changeOf(state, event)
  if (change && !session.updateCheckout(state.checkout.label, change)) return false
  dispatch(event)
  return true
}

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

function sideCard(c: session.Checkout, rows: HTMLElement, ...rest: (Node | null)[]): HTMLElement {
  return el("aside", { class: "panel summary" }, el("span", { class: "label" }, "Your order"), nameTitle(c.label, "nm order-name", c.chain.tld), rows, ...rest)
}

// a checkout held by a waiting card order does not say how it pays yet
function rowsOf(c: session.Checkout, blocked: boolean): [string, string][] {
  const rows: [string, string][] = [["Term", termText(years(c))], ["Registered until", `about ${dateOf(untilFromNow(years(c)), true)}`]]
  if (c.code) rows.push(["Code", codeStart(c.code)])
  else if (!blocked) rows.push(["Paying with", methodName(c.method)])
  return rows
}

// The card's rows by label: a value fades across in its cell, a row whose label goes gives way to the row taking its
// place, and a row with no place left fades out.
function orderRows(first: [string, string][]): { node: HTMLElement; set: (rows: [string, string][]) => void } {
  const made = ([label, text]: [string, string]) => {
    const value = live(el("span", {}, text))
    return { label, row: el("div", { class: "r" }, el("span", {}, label), value), value }
  }
  let drawn = first.map(made)
  const node = live(el("div", { class: "rows" }, ...drawn.map((r) => r.row)))
  const set = (rows: [string, string][]) => {
    const labels = rows.map(([label]) => label)
    const leaving = drawn.filter((r) => !labels.includes(r.label))
    const next = rows.map(([label, text], i) => {
      const kept = drawn.find((r) => r.label === label)
      if (kept) {
        changeTo(kept.value, text)
        return kept
      }
      const fresh = made([label, text])
      const at = drawn[i]
      if (at && leaving.includes(at)) {
        leaving.splice(leaving.indexOf(at), 1)
        removeFrom(node, at.row, fresh.row)
      } else addTo(node, fresh.row, at?.row ?? null)
      return fresh
    })
    for (const r of leaving) removeFrom(node, r.row)
    drawn = next
  }
  return { node, set }
}

const totalOf = (c: session.Checkout) => c.code ? [el("s", {}, dollars(priceFor(c.price, years(c)), true)), "$0.00"] : [dollars(c.price, true)]
function totalLine(c: session.Checkout): { node: HTMLElement; set: (c: session.Checkout) => void } {
  const value = live(el("b", {}, ...totalOf(c)))
  return { node: el("div", { class: "total" }, el("span", { class: "label" }, "Total"), value), set: (next) => changeTo(value, ...totalOf(next)) }
}

// a page drawn while its order is on its way says so on its button
function labelAs(button: HTMLButtonElement, text: string, s: CheckoutState): void {
  const label = s.sending && !s.busy ? "Sending your order…" : text
  if (button.firstChild!.textContent !== label) button.firstChild!.textContent = label
}

// A part changed while a view transition runs takes its new content once the transition is over; focus goes to the
// control then, unless the reader has put it somewhere meanwhile.
function focusOnceShown(find: () => HTMLElement | null): void {
  const target = find()
  if (target) return target.focus({ preventScroll: true })
  void transitionsIdle().then(() => {
    if (document.activeElement === null || document.activeElement === document.body) find()?.focus({ preventScroll: true })
  })
}

const subLink = (text: string, onclick: () => void) => el("div", { class: "sub-links" }, link(text, onclick))

// The payment methods as one radio group, with a note of a method refused and of an unpaid invoice above them.
function methodsPart(fromApp: boolean, choose: (m: Method) => void): { node: HTMLElement; set: (s: CheckoutState) => void; radio: (m: Method) => HTMLElement } {
  const openOrder = live(el("div", { class: "open-order" }))
  const unavailable = live(el("div", {}))
  // one Tab stop for the group, as a radio group has; arrows move between the methods open to choose
  const keyed = (e: KeyboardEvent, m: Method) => {
    const open = METHOD_ORDER.filter((other) => other !== state.checkout.unavailable)
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
    if (e.key === "Enter" || e.key === " ") choose(m)
    else if (by) choose(open[(open.indexOf(m) + by + open.length) % open.length])
    else return
    e.preventDefault()
  }
  const radios = new Map(METHOD_ORDER.map((m) => {
    const line = live(el("span", {}, METHODS[m]))
    const node = el("div", { class: "method", role: "radio", "data-method": m, onclick: () => choose(m), onkeydown: (e: Event) => keyed(e as KeyboardEvent, m) },
      el("span", { class: "radio" }), methodMark(m), el("div", {}, el("b", {}, methodName(m)), el("br"), line))
    return [m, { node, line }] as const
  }))
  const node = el("div", {}, el("div", { class: "sec-title" }, el("h2", {}, "Payment method")), openOrder, unavailable,
    el("p", { class: "sec-note" }, fromApp ? "You pay on the next page." : "You pay on the next pages, after saving your name code."),
    el("div", { class: "methods", role: "radiogroup", "aria-label": "Payment method" }, ...[...radios.values()].map((r) => r.node)))
  const set = ({ checkout: c, openOrder: order }: CheckoutState) => {
    for (const [m, { node, line }] of radios) {
      const [on, off] = [m === c.method, m === c.unavailable]
      node.classList.toggle("on", on)
      node.classList.toggle("off", off)
      node.setAttribute("aria-checked", String(on))
      node.tabIndex = on ? 0 : -1
      if (off) node.setAttribute("aria-disabled", "true")
      else node.removeAttribute("aria-disabled")
      changeTo(line, off ? "Temporarily unavailable" : METHODS[m])
    }
    drawAs(unavailable, c.unavailable ?? "", () => c.unavailable
      ? [el("div", { class: "mb-14" }, alertBox("warn", "alert", `${methodName(c.unavailable)} is temporarily unavailable`, "Try another method, or come back later."))] : [])
    drawAs(openOrder, order ? `${order.invoiceId} ${order.confirming}` : "", () => order
      ? [el("div", { class: "mb-14" }, alertBox("info", "clock", `${order.label}.${order.tld} ${order.confirming ? "is confirming its payment" : "is waiting for its payment"}`,
        el("a", { href: store.invoiceUrl(order.invoiceId) }, "Open that order")))] : [])
  }
  return { node, set, radio: (m) => radios.get(m)!.node }
}

function buildCheckout(s: CheckoutState, signal: AbortSignal): Built<CheckoutState> {
  const c = s.checkout
  const fromApp = c.appOwner !== null
  // the link fields stay as they are through every change of the page, with what is typed and any preview still loading
  const linksSec = fromApp ? null : el("div", { class: "panel-sec" },
    el("div", { class: "sec-title" }, el("h2", {}, "Point it at your SimpleX"), el("span", { class: "opt" }, "Optional")),
    el("p", { class: "sec-note" }, "Set in the same registration. You can change them later."),
    linkField("contact", "Paste your address", "Address", c.contact, (link) => act({ type: "link-set", kind: "contact", link }), signal),
    linkField("channel", "Paste your channel", "Channel", c.channel, (link) => act({ type: "link-set", kind: "channel", link }), signal))
  const methods = methodsPart(fromApp, (m) => {
    if (m === state.checkout.unavailable || !act({ type: "method-chosen", method: m })) return
    methods.radio(m).focus({ preventScroll: true })
  })
  // what pays: the methods, the code, or the waiting order that holds a second one; it crosses over as one part
  const payPart = live(el("div", {}))
  const storage = store.canPersist() ? null : el("div", { class: "panel-sec" },
    fromApp
      ? alertBox("warn", "alert", "This browser will not keep this order", "Keep this page open until the name is registered; a reload loses it.")
      : alertBox("warn", "alert", "This browser will not keep your name code", "The next step shows it: your saved copy will be the only one."))
  const main = el("div", { class: "panel" }, storage, linksSec, el("div", { class: "panel-sec" }, payPart))

  const rows = orderRows(rowsOf(c, blockedBy(s) !== null))
  const total = totalLine(c)
  const onward = btn("Continue", "lg block", () => {
    const pending = [...main.querySelectorAll<HTMLElement>(".link-field")].find((f) => f.dataset.state === "bad" || f.dataset.state === "checking")
    if (pending) return pending.querySelector("input")!.focus()
    if (fromApp) void submitOrder()
    else go("/#/checkout/code")
  }, icon("arrow"))
  const codeArea = live(el("div", {}))
  // the code's link and its field take turns, each fading out of its slot as the other comes
  const linkSlot = live(el("div", {}))
  const stepsOf = (now: session.Checkout) => crumbs("Details", { fromApp, prepaid: now.code !== null, links: { Search: searchLink(now.label, now.appOwner) } })
  const steps = stepsOf(c)
  const holdNote = liveRegion()
  const watchHold = holdEnds(signal)
  let entryInput: HTMLInputElement | null = null
  const openEntry = () => {
    act({ type: "entry-opened" })
    focusOnceShown(() => entryInput?.isConnected ? entryInput : null)
  }
  const applyCode = (code: session.AppliedCode) => {
    // focus in the field that goes moves to the link that removes the code
    if (act({ type: "code-applied", code })) focusOnceShown(() => current<HTMLElement>(linkSlot, "a"))
  }
  const removeCode = () => {
    act({ type: "code-removed" })
    session.setAppliedCode(null)
  }

  const update = (next: CheckoutState) => {
    const now = next.checkout
    const blocked = blockedBy(next)
    rows.set(rowsOf(now, blocked !== null))
    total.set(now)
    methods.set(next)
    drawAs(payPart, now.code ? `code ${now.code.years}` : blocked ? `waiting ${blocked.invoiceId}` : "methods", () => {
      if (now.code) return [el("div", {}, el("div", { class: "sec-title" }, el("h2", {}, "Payment")),
        el("div", { class: "covered-box" }, icon("check"), el("div", {}, "Paid with your code", el("p", {}, `Registered for ${termText(now.code.years)}, with nothing to pay.`))))]
      if (blocked) return [el("div", {}, el("div", { class: "sec-title" }, el("h2", {}, "Payment method")),
        alertBox("info", "info", "You have an order waiting to be confirmed", "A second order would be a second charge, so this one cannot start yet. When that payment is confirmed or expires, you can start a new one here."),
        el("div", { class: "mt-14" }, btn("Open the waiting order", "quiet", () => go(store.invoiceUrl(blocked.invoiceId)))))]
      return [methods.node]
    })
    drawAs(codeArea, next.entry ? "entry" : now.codeError ?? "", () => {
      if (next.entry) {
        const entry = codeEntry(now.label, signal, applyCode)
        entryInput = entry.input
        return [entry.node]
      }
      return now.codeError ? [el("div", { class: "code-entry" }, el("span", { class: "label" }, "Your code"), el("div", { class: "line bad" }, icon("x"), now.codeError))] : []
    })
    const offered = fromApp ? null : now.code ? "remove" : blocked || next.entry ? null : "add"
    drawAs(linkSlot, offered ?? "", () => offered === "remove" ? [subLink("Remove the code", removeCode)] : offered === "add" ? [subLink("I have a code", openEntry)] : [])
    // a code takes the payment step out of the steps, and only that step goes
    crumbsTo(steps, stepsOf(now))
    setAction(onward, next.busy, blocked !== null || next.sending || (fromApp && next.hold !== null))
    labelAs(onward, "Continue", next)
    // an order opened from the app is sent from here, so a wait met in this tab holds it as the code page's would
    const held = fromApp && !blocked && !next.sending ? next.hold : null
    drawAs(holdNote, JSON.stringify(held), () => held === null ? [] : [holdNotice(held)])
    watchHold(next.hold !== null)
  }
  update(s)
  const side = sideCard(c, rows.node, codeArea, total.node, onward, holdNote, linkSlot,
    el("p", { class: "fine" }, icon("shield"), fromApp
      ? el("span", {}, "Registered to your app's wallet, ", el("span", { class: "nowrap" }, shortAddress(c.appOwner!)), ".")
      : "Registered to a wallet made in this browser; nobody else holds its key."),
    fromApp ? null : el("div", { class: "mini-invest" }, INVEST_LINE, el("br"), el("a", { href: WEFUNDER_URL, target: "_blank", rel: "noopener" }, "Learn more on Wefunder\u00a0↗")))
  return { sections: [pageHead("Check your order", null, steps), twoCols(main, side)], update }
}

function codeEntry(label: string, signal: AbortSignal, apply: (code: session.AppliedCode) => void): { node: HTMLElement; input: HTMLInputElement } {
  const input = el("input", { type: "text", "aria-label": "Code", spellcheck: "false", placeholder: "SN6-…", autocomplete: "off" })
  const box = el("div", { class: "input code-input mt-8" }, icon("key"), input)
  const line = liveRegion()
  watchCode(input, (v) => {
    if (signal.aborted) return
    if (!v) {
      box.className = "input code-input mt-8"
      return changeTo(line)
    }
    if (v.ok && label.length < v.code.minLength) {
      box.className = "input code-input mt-8 bad"
      return changeTo(line, el("div", { class: "line bad" }, icon("x"), `This code covers names of ${v.code.minLength} or more letters; ${label} has ${label.length}.`))
    }
    box.className = `input code-input mt-8 ${v.ok ? "ok" : "bad"}`
    if (!v.ok) return changeTo(line, verdictNode(v))
    apply(v.code)
  })
  return { node: el("div", { class: "code-entry" }, el("span", { class: "label" }, "Your code"), box, line), input }
}

function buildOwnerCode(s: CheckoutState, signal: AbortSignal): Built<CheckoutState> {
  const c = s.checkout
  const box = el("input", { type: "checkbox", checked: c.saved })
  const label = c.code ? "Register" : "Continue to payment"
  const action = btn(label, "lg block", () => void submitOrder(), icon("arrow"))
  box.addEventListener("change", () => { if (!act({ type: "saved", saved: box.checked })) redirect("/#/names") })
  const holdNote = liveRegion()
  const rows = orderRows(rowsOf(c, false))
  const total = totalLine(c)
  const watchHold = holdEnds(signal)
  const update = (next: CheckoutState) => {
    box.checked = next.checkout.saved
    setAction(action, next.busy, !next.checkout.saved || next.sending || next.hold !== null)
    labelAs(action, label, next)
    drawAs(holdNote, JSON.stringify(next.hold), () => next.hold === null ? [] : [holdNotice(next.hold)])
    watchHold(next.hold !== null)
  }
  update(s)
  return { sections: [pageHead("Save your name code", ["It will own ", nameText(c.label, c.chain.tld, "."), " If you lose it, nothing else can recover the name."], crumbs("Name code", { prepaid: c.code !== null, links: { Search: searchLink(c.label, c.appOwner), Details: "/#/checkout" } })),
    twoCols(
      el("div", { class: "panel" }, el("div", { class: "panel-sec" },
        el("div", { class: "sec-title" }, el("h2", {}, "Your name code")),
        el("p", { class: "sec-note" }, "Copy it somewhere safe or write it down. You redeem it in the app later."),
        store.canPersist() ? null : el("div", { class: "mb-14" }, alertBox("warn", "alert", "This browser will not keep your name code", "Your saved copy will be the only one.")),
        codeDisplay(c.ownerCode!, "owner-code"),
        el("label", { class: "check" }, box, el("span", { class: "box" }), "I have saved my code"))),
      sideCard(c, rows.node, total.node, action, holdNote,
        el("div", { class: "why" },
          el("div", {}, icon("key"), "The code owns the name once registered."),
          el("div", {}, icon("shield"), "The service never sees it; nobody else has a copy."),
          el("div", {}, icon("refresh"), "It also finishes the order on another browser, if this one loses it."))))], update }
}

function buildPriceChanged({ checkout: c }: CheckoutState): Built<CheckoutState> {
  return unchanging([status("warn", "alert", "The price changed", [nameText(c.label, c.chain.tld), ` costs ${dollars(c.price, true)} now; it changed while you were deciding. Nothing was charged.`],
    [btn("Search again", "", () => go(searchLink(c.label, c.appOwner)))])])
}

function buildTooMany(s: CheckoutState, signal: AbortSignal): Built<CheckoutState> {
  const c = s.checkout
  // the checkout an order was sent from is drawn again; from the name code it is opened
  const again = btn("Try again", "counting", () => s.page === "checkout" ? refresh() : go("/#/checkout"))
  let hold = s.hold
  const watchHold = holdEnds(signal)
  const count = () => {
    const text = hold === null ? "Try again" : `Try again in ${seconds(Math.max(1, secondsLeft(hold)))}`
    if (again.textContent === text) return
    // the button keeps the width of its longest line, so the count moves neither it nor the button beside it
    if (again.isConnected && !again.style.minWidth) again.style.minWidth = `${again.offsetWidth}px`
    again.textContent = text
  }
  const update = (next: CheckoutState) => {
    hold = next.hold
    setAction(again, false, hold !== null)
    count()
    watchHold(hold !== null)
  }
  update(s)
  every(1000, count, signal)
  return { sections: [status("warn", "clock", "Too many attempts", "Too many orders were tried from here, so ordering is paused. Nothing was charged.",
    [again, btn("Back", "quiet", () => go(searchLink(c.label, c.appOwner)))])], update }
}

function buildFailed(s: CheckoutState): Built<CheckoutState> {
  const c = s.checkout
  // the same order is sent again from here; Back leaves it for the search
  const retry = btn("Try again", "", () => void submitOrder())
  const update = (next: CheckoutState) => setAction(retry, next.busy, false)
  update(s)
  return { sections: [status("bad", "alert", "That did not go through", "Nothing was charged. If this happens again, get in touch.",
    [retry, btn("Back", "quiet", () => go(searchLink(c.label, c.appOwner)))])], update }
}

const BUILDS: Record<CheckoutKind, Build<CheckoutState>> = {
  checkout: buildCheckout,
  "owner-code": buildOwnerCode,
  "status:price-changed": buildPriceChanged,
  "status:too-many": buildTooMany,
  "status:failed": buildFailed,
}

// The field's data-state says whether its link is "ok", "bad", or "empty"; save gets the link only when it is ok.
let linkFields = 0
type Preview = Awaited<ReturnType<typeof api.previewLink>>
// a link's profile as shown, so a field drawn again for it, as a step gone back to, shows it at once
const previews = new Map<string, Preview>()

// A field on a screen checks its link while the screen is shown, through every change of it; one without a screen's
// signal, while its route is.
export function linkField(kind: LinkKind, placeholder: string, label: string, value: string, save: (v: string) => void, signal?: AbortSignal): HTMLElement {
  const errorId = `link-error-${++linkFields}`
  const input = el("input", { type: "text", placeholder, value, "aria-label": label, spellcheck: "false", autocomplete: "off" })
  const box = el("div", { class: "input" }, icon("link"), input, el("span", { class: "kind" }, label))
  const card = live(el("div", {}))
  const field = el("div", { class: "link-field" }, box, card)
  const route = currentRoute()
  const shown = () => signal ? !signal.aborted : isRoute(route)
  let seq = 0
  // the card's place is held while the link is checked, so the page is laid out at its height from the start
  const holdCardPlace = () => {
    if (!current(card, ".skeleton")) card.replaceChildren(el("div", { class: "entity-wrap", "aria-hidden": "true" }, el("div", { class: "entity skeleton" })))
  }
  const refuse = (text: string) => {
    box.className = "input bad"
    field.dataset.state = "bad"
    input.setAttribute("aria-invalid", "true")
    input.setAttribute("aria-describedby", errorId)
    // the same refusal again, as typing on in a refused link gives, keeps still
    if (current(card, ".field-error")?.textContent !== text) card.replaceChildren(el("p", { class: "field-error", id: errorId }, icon("alert"), text))
  }
  const check = async () => {
    const mine = ++seq
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
          (left) => `The link could not be checked now. Checking again in ${left}.`, () => { if (mine === seq) void check() })
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
  // a card payment awaiting confirmation blocks a second paid order, from this page as from checkout; nothing is held
  if (!c.code && waitingCardOrder()) return go("/#/checkout")
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
    if (ours) {
      session.setCheckout(null)
      if (c.code) session.setAppliedCode(null)
    }
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
    session.setAppliedCode(null)
    return answer({ type: "order-refused", reason: "code", error: CODE_ERRORS[code] })
  }
  if (code === "provider_unavailable") return answer({ type: "order-refused", reason: "method" })
  if (code === "catalog_changed" && e instanceof api.ApiError && typeof e.body.price === "number") return void act({ type: "price-changed", price: e.body.price })
  // the tab's wait started as the order was refused; the page holds for what is left of it
  if (code === "rate_limited") return dispatch({ type: "hold-started", until: holdEnd() })
  dispatch({ type: "order-refused", reason: "failed" })
}

// A refusal the checkout answers is shown on it: in place for an order sent from it, or back on it from the name code,
// which takes it from storage as it opens.
function answer(event: CheckoutEvent): void {
  if (state.page === "checkout") return void act(event)
  const change = changeOf(state, event)
  if (change) session.updateCheckout(state.checkout.label, change)
  go("/#/checkout")
}
