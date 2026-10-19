import { describe, expect, it } from "vitest"
import {
  changeOf, type CheckoutEvent, type CheckoutKind, type CheckoutState, FALLBACK_METHOD, initialState, reduce, screenOf,
} from "../src/screens/checkout.ts"
import { NO_LEAD } from "../src/screens/hold.ts"
import type { Checkout } from "../src/session.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const CODE = { display: "SN6-AAAAA-BBBBB-CCCCC", minLength: 6, years: 3 }
const WAITING = { registrationId: "reg-0", invoiceId: "inv-0" }
const OPEN_ORDER = { invoiceId: "inv-9", label: "bobby", tld: "simplex", confirming: false }

function checkout(change: Partial<Checkout> = {}): Checkout {
  return {
    label: "alice1", price: 1500, chain: CHAIN, contact: "", channel: "", method: "btc", code: null, ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF",
    saved: false, appOwner: null, appSecret: null, ...change,
  }
}

const opened = (s: CheckoutState, change: Partial<Extract<CheckoutEvent, { type: "opened" }>> = {}): CheckoutEvent =>
  ({ type: "opened", checkout: s.checkout, sending: false, waiting: null, hold: null, ...change })
const open = (change: Partial<CheckoutState> = {}): CheckoutState => ({ ...initialState(checkout()), ...change })

const STATES: Record<CheckoutKind, CheckoutState> = {
  checkout: open(),
  "status:price-changed": open({ checkout: checkout({ price: 2500 }), refusal: "price-changed" }),
  "status:too-many": open({ hold: { until: NOW + 30_000, lead: NO_LEAD }, refusal: "too-many" }),
  "status:failed": open({ refusal: "failed" }),
}

describe("screenOf", () => {
  const cases: [string, CheckoutState, CheckoutKind][] = [
    ["the checkout", open(), "checkout"],
    ["the checkout with its order on its way", open({ sending: true, busy: true }), "checkout"],
    ["the checkout with its code saved", open({ checkout: checkout({ saved: true }) }), "checkout"],
    ["the checkout during a wait", open({ hold: { until: NOW + 5000, lead: NO_LEAD } }), "checkout"],
    ["an order refused for a changed price", STATES["status:price-changed"], "status:price-changed"],
    ["an order that met a rate limit", STATES["status:too-many"], "status:too-many"],
    ["an order that did not go through", STATES["status:failed"], "status:failed"],
  ]
  it.each(cases)("%s", (_, state, kind) => {
    expect(screenOf(state)).toBe(kind)
  })
  it("is the one checkout page until the service refuses the order", () => {
    expect(screenOf(initialState(checkout()))).toBe("checkout")
    expect(screenOf(reduce(initialState(checkout()), { type: "order-refused", reason: "failed" }))).toBe("status:failed")
    expect(screenOf(reduce(initialState(checkout()), { type: "hold-started", until: 5 }))).toBe("status:too-many")
  })
  it("a code applied clears the code's last refusal and stays on the page", () => {
    const refused = reduce(initialState(checkout()), { type: "order-refused", reason: "code", error: "This code was already used." })
    const applied = reduce(refused, { type: "code-applied", code: CODE })
    expect(applied.checkout.codeError).toBeUndefined()
    expect(screenOf(applied)).toBe("checkout")
  })
})

describe("changeOf", () => {
  const s = STATES.checkout
  it("gives each change of the stored checkout", () => {
    expect(changeOf(s, { type: "method-chosen", method: "xmr" })).toEqual({ method: "xmr" })
    expect(changeOf(s, { type: "link-set", kind: "contact", link: "https://smp8.simplex.im/a#x" })).toEqual({ contact: "https://smp8.simplex.im/a#x" })
    expect(changeOf(s, { type: "link-set", kind: "channel", link: "https://smp9.simplex.im/c#y" })).toEqual({ channel: "https://smp9.simplex.im/c#y" })
    expect(changeOf(s, { type: "code-applied", code: CODE })).toEqual({ code: CODE, codeError: undefined })
    expect(changeOf(s, { type: "code-removed" })).toEqual({ code: null, codeError: undefined })
    expect(changeOf(s, { type: "saved", saved: true })).toEqual({ saved: true })
    expect(changeOf(s, { type: "order-refused", reason: "code", error: "This code was already used." })).toEqual({ code: null, codeError: "This code was already used." })
    expect(changeOf(s, { type: "price-changed", price: 2500 })).toEqual({ price: 2500 })
  })
  it("a method refused marks it unavailable and chooses the next one", () => {
    for (const method of ["card", "btc", "xmr"] as const) {
      expect(changeOf(open({ checkout: checkout({ method }) }), { type: "order-refused", reason: "method" })).toEqual({ unavailable: method, method: FALLBACK_METHOD[method] })
    }
    expect(FALLBACK_METHOD).toEqual({ card: "btc", btc: "xmr", xmr: "btc" })
  })
  it("a link is written even when the state has it, as a field saves it again before the page takes the first save", () => {
    expect(changeOf(open({ checkout: checkout({ contact: "https://smp8.simplex.im/a#x" }) }), { type: "link-set", kind: "contact", link: "https://smp8.simplex.im/a#x" }))
      .toEqual({ contact: "https://smp8.simplex.im/a#x" })
  })
  it("the method already chosen, or one unavailable, changes nothing", () => {
    expect(changeOf(s, { type: "method-chosen", method: "btc" })).toBeNull()
    expect(changeOf(open({ checkout: checkout({ unavailable: "card" }) }), { type: "method-chosen", method: "card" })).toBeNull()
  })
  it("events that are not the stored checkout's change nothing in it", () => {
    const others: CheckoutEvent[] = [opened(s), { type: "waiting-settled" }, { type: "open-order-seen", order: OPEN_ORDER },
      { type: "send-started" }, { type: "order-refused", reason: "failed" }, { type: "hold-started", until: NOW }, { type: "hold-ended" }]
    for (const e of others) expect(changeOf(s, e), e.type).toBeNull()
  })
})

describe("reduce", () => {
  const s = STATES.checkout

  it("opened takes the checkout as stored and what the tab knew, ending a refusal and the page's own send", () => {
    const stored = checkout({ method: "card", contact: "https://smp8.simplex.im/a#x" })
    const refused = { ...s, refusal: "too-many" as const, busy: true, sending: true, openOrder: OPEN_ORDER }
    expect(reduce(refused, opened(s, { checkout: stored, sending: true, waiting: WAITING, hold: { until: NOW + 1000, lead: NO_LEAD } }))).toEqual({
      ...refused, checkout: stored, sending: true, busy: false, waiting: WAITING, hold: { until: NOW + 1000, lead: NO_LEAD }, refusal: null,
    })
  })
  it("opened keeps the code the tab's checkout carries, as Back and Register for the same name give it", () => {
    expect(reduce(s, opened(s, { checkout: checkout({ code: CODE }) }))).toEqual({ ...s, checkout: checkout({ code: CODE }) })
  })
  it("method-chosen chooses the method", () => {
    expect(reduce(s, { type: "method-chosen", method: "card" }).checkout).toEqual(checkout({ method: "card" }))
  })
  it("method-chosen for the method chosen, or one unavailable, keeps the state", () => {
    expect(reduce(s, { type: "method-chosen", method: "btc" })).toBe(s)
    const off = open({ checkout: checkout({ unavailable: "card" }) })
    expect(reduce(off, { type: "method-chosen", method: "card" })).toBe(off)
  })
  it("link-set keeps the link typed, an emptied field too", () => {
    const set = reduce(s, { type: "link-set", kind: "contact", link: "https://smp8.simplex.im/a#x" })
    expect(set).toEqual({ ...s, checkout: checkout({ contact: "https://smp8.simplex.im/a#x" }) })
    expect(reduce(set, { type: "link-set", kind: "contact", link: "" })).toEqual(s)
  })
  it("code-applied applies the code and clears the last refusal of one", () => {
    const refused = { ...s, checkout: checkout({ codeError: "This code has expired." }) }
    expect(reduce(refused, { type: "code-applied", code: CODE })).toEqual({ ...s, checkout: { ...checkout(), code: CODE, codeError: undefined } })
  })
  it("code-removed takes the code off", () => {
    const covered = { ...s, checkout: checkout({ code: CODE }) }
    expect(reduce(covered, { type: "code-removed" })).toEqual({ ...s, checkout: checkout({ code: null }) })
  })
  it("code-removed, as an edit of the code's field gives, drops the service's last refusal of a code", () => {
    const refused = reduce(s, { type: "order-refused", reason: "code", error: "This code was already used." })
    expect(refused.checkout.codeError).toBe("This code was already used.")
    const edited = reduce(refused, { type: "code-removed" })
    expect(edited.checkout).toHaveProperty("codeError", undefined)
    expect(screenOf(edited)).toBe("checkout")
  })
  it("saved ticks and unticks the saved box", () => {
    const ticked = open({ checkout: checkout({ saved: true }) })
    expect(reduce(ticked, { type: "saved", saved: false }).checkout.saved).toBe(false)
    expect(reduce(reduce(ticked, { type: "saved", saved: false }), { type: "saved", saved: true })).toEqual(ticked)
  })
  it("waiting-settled lets the card order that blocked a second one go", () => {
    expect(reduce({ ...s, waiting: WAITING }, { type: "waiting-settled" })).toEqual(s)
  })
  it("open-order-seen points at an unpaid invoice", () => {
    expect(reduce(s, { type: "open-order-seen", order: OPEN_ORDER })).toEqual({ ...s, openOrder: OPEN_ORDER })
  })
  it("send-started marks the order on its way from this page", () => {
    expect(reduce(s, { type: "send-started" })).toEqual({ ...s, sending: true, busy: true })
  })
  it("order-refused for the code takes it off and says why, on the page it was sent from", () => {
    const sent = { ...s, sending: true, busy: true, checkout: checkout({ code: CODE }) }
    expect(reduce(sent, { type: "order-refused", reason: "code", error: "This code was already used." }))
      .toEqual({ ...s, checkout: checkout({ code: null, codeError: "This code was already used." }) })
  })
  it("order-refused for the method marks it unavailable and chooses another", () => {
    const sent = { ...s, sending: true, busy: true, checkout: checkout({ method: "card" }) }
    expect(reduce(sent, { type: "order-refused", reason: "method" })).toEqual({ ...s, checkout: checkout({ method: "btc", unavailable: "card" }) })
  })
  it("order-refused with no reason the checkout answers says it did not go through", () => {
    expect(reduce({ ...s, sending: true, busy: true }, { type: "order-refused", reason: "failed" })).toEqual({ ...s, refusal: "failed" })
  })
  it("price-changed keeps the new price and says so", () => {
    expect(reduce({ ...s, sending: true, busy: true }, { type: "price-changed", price: 2500 })).toEqual({ ...s, checkout: checkout({ price: 2500 }), refusal: "price-changed" })
  })
  it("hold-started holds the tab and says the order met a rate limit", () => {
    expect(reduce({ ...s, sending: true, busy: true }, { type: "hold-started", until: NOW + 30_000 })).toEqual({ ...s, hold: { until: NOW + 30_000, lead: NO_LEAD }, refusal: "too-many" })
  })
  it("hold-started with a shorter wait than the one running keeps the longer one", () => {
    expect(reduce({ ...s, hold: { until: NOW + 60_000, lead: NO_LEAD } }, { type: "hold-started", until: NOW + 30_000 }).hold).toEqual({ until: NOW + 60_000, lead: NO_LEAD })
  })
  it("hold-ended ends the wait, on the page that met it too", () => {
    expect(reduce(STATES["status:too-many"], { type: "hold-ended" })).toEqual({ ...STATES["status:too-many"], hold: null })
  })
  it("an invoice pointed at while the order is on its way stays pointed at once the order is refused", () => {
    const sent = reduce(s, { type: "send-started" })
    const failed = reduce(reduce(sent, { type: "open-order-seen", order: OPEN_ORDER }), { type: "order-refused", reason: "failed" })
    expect(failed).toEqual({ ...s, openOrder: OPEN_ORDER, refusal: "failed" })
  })
})

describe("initialState", () => {
  it("starts with the checkout as stored and nothing else known", () => {
    expect(initialState(checkout())).toEqual({
      checkout: checkout(), sending: false, busy: false, waiting: null, openOrder: null, hold: null, refusal: null,
    })
  })
})
