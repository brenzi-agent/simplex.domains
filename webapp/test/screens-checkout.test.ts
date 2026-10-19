import { describe, expect, it, vi } from "vitest"
import {
  changeOf, checkoutMachine, type CheckoutEvent, type CheckoutKind, type CheckoutState, FALLBACK_METHOD, initialState, moves, reduce, screenOf,
} from "../src/screens/checkout.ts"
import { NO_LEAD, step } from "../src/screens/machine.ts"
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
const open = (page: CheckoutState["page"], change: Partial<CheckoutState> = {}): CheckoutState => ({ ...initialState(page, checkout()), ...change })

const STATES: Record<CheckoutKind, CheckoutState> = {
  checkout: open("checkout"),
  "owner-code": open("owner-code", { checkout: checkout({ saved: true }) }),
  "status:price-changed": open("owner-code", { checkout: checkout({ price: 2500 }), refusal: "price-changed" }),
  "status:too-many": open("owner-code", { hold: { until: NOW + 30_000, lead: NO_LEAD }, refusal: "too-many" }),
  "status:failed": open("owner-code", { refusal: "failed" }),
}

function eventTo(to: CheckoutKind, s: CheckoutState): { state: CheckoutState; event: CheckoutEvent } {
  const sent = { ...s, sending: true, busy: true }
  if (to === "status:price-changed") return { state: sent, event: { type: "price-changed", price: 2500 } }
  if (to === "status:too-many") return { state: sent, event: { type: "hold-started", until: NOW + 30_000 } }
  if (to === "status:failed") return { state: sent, event: { type: "order-refused", reason: "failed" } }
  return { state: { ...s, page: to }, event: opened(s, { hold: null }) }
}

describe("screenOf", () => {
  const cases: [string, CheckoutState, CheckoutKind][] = [
    ["the checkout", open("checkout"), "checkout"],
    ["the checkout with its order on its way", open("checkout", { sending: true, busy: true }), "checkout"],
    ["the name code", open("owner-code"), "owner-code"],
    ["the name code during a wait", open("owner-code", { hold: { until: NOW + 5000, lead: NO_LEAD } }), "owner-code"],
    ["an order refused for a changed price", STATES["status:price-changed"], "status:price-changed"],
    ["an order that met a rate limit", STATES["status:too-many"], "status:too-many"],
    ["an order sent from the checkout that met a rate limit", open("checkout", { refusal: "too-many" }), "status:too-many"],
    ["an order that did not go through", STATES["status:failed"], "status:failed"],
  ]
  it.each(cases)("%s", (_, state, kind) => {
    expect(screenOf(state)).toBe(kind)
  })
})

describe("moves", () => {
  const rows = Object.entries(moves).flatMap(([from, to]) => Object.entries(to).map(([next, motion]): [CheckoutKind, CheckoutKind, string] => [from as CheckoutKind, next as CheckoutKind, motion]))
  it("lists the refusals as page changes", () => {
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(([, , motion]) => motion === "screen")).toBe(true)
  })
  it.each(rows)("%s → %s", (from, to, motion) => {
    const warn = vi.fn()
    const { state, event } = eventTo(to, STATES[from])
    expect(screenOf(state)).toBe(from)
    const result = step(checkoutMachine, state, from, event, warn)
    expect(result).toMatchObject({ screen: to, motion, expected: true })
    expect(warn).not.toHaveBeenCalled()
  })
  it("an order tried again from the checkout and refused for its method draws the checkout with another one chosen", () => {
    const warn = vi.fn()
    const sent = { ...STATES["status:failed"], page: "checkout" as const, sending: true, busy: true }
    const result = step(checkoutMachine, sent, "status:failed", { type: "order-refused", reason: "method" }, warn)
    expect(result).toMatchObject({ screen: "checkout", motion: "screen", expected: true })
    expect(result.state.checkout).toMatchObject({ method: "xmr", unavailable: "btc" })
    expect(warn).not.toHaveBeenCalled()
  })
  it("logs a move no checkout makes, and still shows it", () => {
    const warn = vi.fn()
    const priced = STATES["status:price-changed"]
    const result = step(checkoutMachine, priced, "status:price-changed", { type: "hold-started", until: NOW }, warn)
    expect(result).toMatchObject({ screen: "status:too-many", motion: "screen", expected: false })
    expect(warn).toHaveBeenCalledWith("[screens] checkout: unexpected move status:price-changed → status:too-many")
  })
  it("keeps a screen whose state changes in place", () => {
    const s = STATES.checkout
    expect(step(checkoutMachine, s, "checkout", { type: "code-applied", code: CODE }, vi.fn())).toMatchObject({ screen: "checkout", motion: "in-place", expected: true })
    expect(step(checkoutMachine, STATES["status:too-many"], "status:too-many", { type: "hold-ended" }, vi.fn())).toMatchObject({ screen: "status:too-many", motion: "in-place" })
  })
})

describe("changeOf", () => {
  const s = STATES.checkout
  it("gives each change of the stored checkout", () => {
    expect(changeOf(s, { type: "method-chosen", method: "xmr" })).toEqual({ method: "xmr" })
    expect(changeOf(s, { type: "link-set", kind: "contact", link: "https://smp8.simplex.im/a#x" })).toEqual({ contact: "https://smp8.simplex.im/a#x" })
    expect(changeOf(s, { type: "link-set", kind: "channel", link: "https://smp9.simplex.im/c#y" })).toEqual({ channel: "https://smp9.simplex.im/c#y" })
    expect(changeOf(s, { type: "code-applied", code: CODE })).toEqual({ code: CODE, codeError: undefined })
    expect(changeOf(s, { type: "code-removed" })).toEqual({ code: null })
    expect(changeOf(s, { type: "saved", saved: true })).toEqual({ saved: true })
    expect(changeOf(s, { type: "order-refused", reason: "code", error: "This code was already used." })).toEqual({ code: null, codeError: "This code was already used." })
    expect(changeOf(s, { type: "price-changed", price: 2500 })).toEqual({ price: 2500 })
  })
  it("a method refused marks it unavailable and chooses the next one", () => {
    for (const method of ["card", "btc", "xmr"] as const) {
      expect(changeOf(open("checkout", { checkout: checkout({ method }) }), { type: "order-refused", reason: "method" })).toEqual({ unavailable: method, method: FALLBACK_METHOD[method] })
    }
    expect(FALLBACK_METHOD).toEqual({ card: "btc", btc: "xmr", xmr: "btc" })
  })
  it("a link is written even when the state has it, as a field saves it again before the page takes the first save", () => {
    expect(changeOf(open("checkout", { checkout: checkout({ contact: "https://smp8.simplex.im/a#x" }) }), { type: "link-set", kind: "contact", link: "https://smp8.simplex.im/a#x" }))
      .toEqual({ contact: "https://smp8.simplex.im/a#x" })
  })
  it("the method already chosen, or one unavailable, changes nothing", () => {
    expect(changeOf(s, { type: "method-chosen", method: "btc" })).toBeNull()
    expect(changeOf(open("checkout", { checkout: checkout({ unavailable: "card" }) }), { type: "method-chosen", method: "card" })).toBeNull()
  })
  it("events that are not the stored checkout's change nothing in it", () => {
    const others: CheckoutEvent[] = [opened(s), { type: "entry-opened" }, { type: "waiting-settled" }, { type: "open-order-seen", order: OPEN_ORDER },
      { type: "send-started" }, { type: "order-refused", reason: "failed" }, { type: "hold-started", until: NOW }, { type: "hold-ended" }]
    for (const e of others) expect(changeOf(s, e), e.type).toBeNull()
  })
})

describe("reduce", () => {
  const s = STATES.checkout

  it("opened takes the checkout as stored and what the tab knew, ending a refusal and the page's own send", () => {
    const stored = checkout({ method: "card", contact: "https://smp8.simplex.im/a#x" })
    const refused = { ...s, refusal: "too-many" as const, busy: true, sending: true, entry: true, openOrder: OPEN_ORDER }
    expect(reduce(refused, opened(s, { checkout: stored, sending: true, waiting: WAITING, hold: { until: NOW + 1000, lead: NO_LEAD } }))).toEqual({
      ...refused, checkout: stored, sending: true, busy: false, waiting: WAITING, hold: { until: NOW + 1000, lead: NO_LEAD }, refusal: null,
    })
  })
  it("opened with a code applied elsewhere, as from the popup, closes the code's field", () => {
    const entering = { ...s, entry: true }
    expect(reduce(entering, opened(s, { checkout: checkout({ code: CODE }) }))).toEqual({ ...s, checkout: checkout({ code: CODE }), entry: false })
  })
  it("method-chosen chooses the method", () => {
    expect(reduce(s, { type: "method-chosen", method: "card" }).checkout).toEqual(checkout({ method: "card" }))
  })
  it("method-chosen for the method chosen, or one unavailable, keeps the state", () => {
    expect(reduce(s, { type: "method-chosen", method: "btc" })).toBe(s)
    const off = open("checkout", { checkout: checkout({ unavailable: "card" }) })
    expect(reduce(off, { type: "method-chosen", method: "card" })).toBe(off)
  })
  it("link-set keeps the link typed, an emptied field too", () => {
    const set = reduce(s, { type: "link-set", kind: "contact", link: "https://smp8.simplex.im/a#x" })
    expect(set).toEqual({ ...s, checkout: checkout({ contact: "https://smp8.simplex.im/a#x" }) })
    expect(reduce(set, { type: "link-set", kind: "contact", link: "" })).toEqual(s)
  })
  it("entry-opened opens the code's field", () => {
    expect(reduce(s, { type: "entry-opened" })).toEqual({ ...s, entry: true })
  })
  it("code-applied applies the code, clears the last refusal of one and closes the field", () => {
    const entering = { ...s, entry: true, checkout: checkout({ codeError: "This code has expired." }) }
    expect(reduce(entering, { type: "code-applied", code: CODE })).toEqual({ ...s, entry: false, checkout: { ...checkout(), code: CODE, codeError: undefined } })
  })
  it("code-removed takes the code off", () => {
    const covered = { ...s, checkout: checkout({ code: CODE }) }
    expect(reduce(covered, { type: "code-removed" })).toEqual({ ...s, checkout: checkout({ code: null }) })
  })
  it("saved ticks and unticks the saved box", () => {
    const code = STATES["owner-code"]
    expect(reduce(code, { type: "saved", saved: false }).checkout.saved).toBe(false)
    expect(reduce(reduce(code, { type: "saved", saved: false }), { type: "saved", saved: true })).toEqual(code)
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
    expect(initialState("owner-code", checkout())).toEqual({
      page: "owner-code", checkout: checkout(), sending: false, busy: false, waiting: null, openOrder: null, hold: null, refusal: null, entry: false,
    })
  })
})
