import { describe, expect, it } from "vitest"
import {
  changeOf, type CheckoutEvent, type CheckoutKind, type CheckoutState, FALLBACK_METHOD, initialState, reduce, screenOf, stepFor,
} from "../src/screens/checkout.ts"
import { NO_LEAD } from "../src/screens/hold.ts"
import type { Checkout } from "../src/session.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const CODE = { display: "SN6-AAAAA-BBBBB-CCCCC", minLength: 6, years: 3 }
const WAITING = { registrationId: "reg-0", invoiceId: "inv-0" }
const OPEN_ORDER = { invoiceId: "inv-9", confirming: false }

function checkout(change: Partial<Checkout> = {}): Checkout {
  return {
    label: "alice1", price: 1500, chain: CHAIN, contact: "", channel: "", method: "btc", code: null, ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF",
    saved: true, appOwner: null, appSecret: null, searchAt: 0, step: "review", ...change,
  }
}

const opened = (s: CheckoutState, change: Partial<Extract<CheckoutEvent, { type: "opened" }>> = {}): CheckoutEvent =>
  ({ type: "opened", step: s.step, checkout: s.checkout, sending: false, waiting: null, hold: null, ...change })
const open = (change: Partial<CheckoutState> = {}): CheckoutState => ({ ...initialState(checkout(), "review"), ...change })
const CONTACT = "https://smp8.simplex.im/a#x"
const CHANNEL = "https://smp9.simplex.im/c#y"

const STATES: Record<CheckoutKind, CheckoutState> = {
  links: open({ step: "links", checkout: checkout({ saved: false }) }),
  code: open({ step: "code", checkout: checkout({ saved: false }) }),
  review: open(),
  "status:price-changed": open({ checkout: checkout({ price: 2500 }), refusal: "price-changed" }),
  "status:too-many": open({ hold: { until: NOW + 30_000, lead: NO_LEAD }, refusal: "too-many" }),
  "status:failed": open({ refusal: "failed" }),
  "status:taken": open({ refusal: "taken" }),
}

describe("screenOf", () => {
  const cases: [string, CheckoutState, CheckoutKind][] = [
    ["the links step", STATES.links, "links"],
    ["the name code step", STATES.code, "code"],
    ["the review", open(), "review"],
    ["the review with its order on its way", open({ sending: true, busy: true }), "review"],
    ["the review with its code field open", open({ codeOpen: true }), "review"],
    ["the review during a wait", open({ hold: { until: NOW + 5000, lead: NO_LEAD } }), "review"],
    ["an order refused for a changed price", STATES["status:price-changed"], "status:price-changed"],
    ["an order that met a rate limit", STATES["status:too-many"], "status:too-many"],
    ["an order that did not go through", STATES["status:failed"], "status:failed"],
    ["an order for a name registered meanwhile", STATES["status:taken"], "status:taken"],
  ]
  it.each(cases)("%s", (_, state, kind) => {
    expect(screenOf(state)).toBe(kind)
  })
  it("is the step opened until the service refuses the order", () => {
    expect(screenOf(initialState(checkout(), "review"))).toBe("review")
    expect(screenOf(reduce(initialState(checkout(), "review"), { type: "order-refused", reason: "failed" }))).toBe("status:failed")
    expect(screenOf(reduce(initialState(checkout(), "review"), { type: "hold-started", until: 5 }))).toBe("status:too-many")
  })
  it("a step opened anew ends the refusal the review showed", () => {
    const refused = reduce(open(), { type: "order-refused", reason: "failed" })
    expect(screenOf(reduce(refused, opened(refused, { step: "links" })))).toBe("links")
  })
  it("a code applied clears the code's last refusal and stays on the page", () => {
    const refused = reduce(initialState(checkout(), "review"), { type: "order-refused", reason: "code", error: "This code was already used." })
    const applied = reduce(refused, { type: "code-applied", code: CODE })
    expect(applied.checkout.codeError).toBeUndefined()
    expect(screenOf(applied)).toBe("review")
  })
})

describe("changeOf", () => {
  const s = STATES.review
  it("gives each change of the stored checkout", () => {
    expect(changeOf(s, { type: "link-set", kind: "contact", link: CONTACT })).toEqual({ contact: CONTACT })
    expect(changeOf(s, { type: "link-set", kind: "channel", link: CHANNEL })).toEqual({ channel: CHANNEL })
    expect(changeOf(s, { type: "saved", saved: false })).toEqual({ saved: false })
    expect(changeOf(s, { type: "method-chosen", method: "xmr" })).toEqual({ method: "xmr" })
    expect(changeOf(s, { type: "code-applied", code: CODE })).toEqual({ code: CODE, codeError: undefined })
    expect(changeOf(s, { type: "code-removed" })).toEqual({ code: null, codeError: undefined })
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
    expect(changeOf(open({ checkout: checkout({ contact: CONTACT }) }), { type: "link-set", kind: "contact", link: CONTACT })).toEqual({ contact: CONTACT })
  })
  it("the method already chosen, or one unavailable, changes nothing", () => {
    expect(changeOf(s, { type: "method-chosen", method: "btc" })).toBeNull()
    expect(changeOf(open({ checkout: checkout({ unavailable: "card" }) }), { type: "method-chosen", method: "card" })).toBeNull()
  })
  it("events that are not the stored checkout's change nothing in it", () => {
    const others: CheckoutEvent[] = [opened(s), { type: "waiting-settled" }, { type: "open-order-seen", order: OPEN_ORDER },
      { type: "send-started" }, { type: "order-refused", reason: "failed" }, { type: "order-refused", reason: "taken" }, { type: "hold-started", until: NOW }, { type: "hold-ended" },
      { type: "code-opened" }]
    for (const e of others) expect(changeOf(s, e), e.type).toBeNull()
  })
})

describe("reduce", () => {
  const s = STATES.review

  it("opened takes the checkout as stored and what the tab knew, ending a refusal and the page's own send", () => {
    const stored = checkout({ method: "card" })
    const refused = { ...s, refusal: "too-many" as const, busy: true, sending: true, openOrder: OPEN_ORDER }
    expect(reduce(refused, opened(s, { checkout: stored, sending: true, waiting: WAITING, hold: { until: NOW + 1000, lead: NO_LEAD } }))).toEqual({
      ...refused, checkout: stored, sending: true, busy: false, waiting: WAITING, hold: { until: NOW + 1000, lead: NO_LEAD }, refusal: null,
    })
  })
  it("opened takes the step the page is on", () => {
    expect(reduce(s, opened(s, { step: "code" })).step).toBe("code")
  })
  it("link-set keeps the link typed, an emptied field too", () => {
    const links = STATES.links
    const set = reduce(links, { type: "link-set", kind: "contact", link: CONTACT })
    expect(set).toEqual({ ...links, checkout: { ...links.checkout, contact: CONTACT } })
    expect(reduce(set, { type: "link-set", kind: "contact", link: "" })).toEqual(links)
  })
  it("saved ticks and unticks the box that lets the buyer go on to the review", () => {
    const code = STATES.code
    const ticked = reduce(code, { type: "saved", saved: true })
    expect(ticked).toEqual({ ...code, checkout: { ...code.checkout, saved: true } })
    expect(reduce(ticked, { type: "saved", saved: false })).toEqual(code)
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
    expect(screenOf(edited)).toBe("review")
  })
  it("code-opened opens the code field, which stays open as the page draws again and the code comes off", () => {
    const shown = reduce(s, { type: "code-opened" })
    expect(shown).toEqual({ ...s, codeOpen: true })
    expect(reduce(shown, opened(shown)).codeOpen).toBe(true)
    expect(reduce(reduce(shown, { type: "code-applied", code: CODE }), { type: "code-removed" }).codeOpen).toBe(true)
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
  it("order-refused for a name registered meanwhile says so, with the checkout as it was", () => {
    expect(reduce({ ...s, sending: true, busy: true }, { type: "order-refused", reason: "taken" })).toEqual({ ...s, refusal: "taken" })
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

describe("stepFor", () => {
  const APP_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
  it("opens each step asked for once the name code is saved", () => {
    for (const step of ["links", "code", "review"] as const) expect(stepFor(checkout(), step)).toBe(step)
  })
  it("sends a review asked for before the code is saved, or made, to the name code step", () => {
    expect(stepFor(checkout({ saved: false }), "review")).toBe("code")
    expect(stepFor(checkout({ ownerCode: null, saved: false }), "review")).toBe("code")
    expect(stepFor(checkout({ ownerCode: null, saved: true }), "review")).toBe("code")
  })
  it("leaves the links and the code step open before the code is saved", () => {
    expect(stepFor(checkout({ saved: false }), "links")).toBe("links")
    expect(stepFor(checkout({ ownerCode: null, saved: false }), "code")).toBe("code")
  })
  it("opens only the review for an order from the app, which brings its wallet", () => {
    const fromApp = checkout({ ownerCode: null, saved: false, appOwner: APP_WALLET })
    for (const step of ["links", "code", "review"] as const) expect(stepFor(fromApp, step)).toBe("review")
  })
})

describe("initialState", () => {
  it("starts on its step with the checkout as stored and nothing else known", () => {
    expect(initialState(checkout(), "links")).toEqual({
      step: "links", checkout: checkout(), sending: false, busy: false, waiting: null, openOrder: null, hold: null, refusal: null, codeOpen: false,
    })
  })
  it("opens the code field for a checkout that carries a code or the service's refusal of one, as after a reload", () => {
    expect(initialState(checkout({ code: CODE }), "review").codeOpen).toBe(true)
    expect(initialState(checkout({ codeError: "This code was already used." }), "review").codeOpen).toBe(true)
  })
  it("keeps the code field open when the page it was opened on is opened again, and closed otherwise", () => {
    expect(initialState(checkout(), "review", true).codeOpen).toBe(true)
    expect(initialState(checkout(), "review", false).codeOpen).toBe(false)
  })
})
