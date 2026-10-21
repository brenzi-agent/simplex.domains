import { describe, expect, it } from "vitest"
import type { InvoiceView, RegistrationView, SearchAnswer } from "../src/api.ts"
import { type Hold, NO_LEAD } from "../src/screens/hold.ts"
import {
  changesOf, CODE_CHIPS, editable, type EditEvent, type EditForm, type EditKind, type EditState, hasRecords, initialEdit,
  GRACE_S, initialList, initialRestore, lapsed, listedOrders, type ListEvent, type ListState, notSaved, phaseChip, reduceEdit, reduceList, reduceRestore, REFUSALS,
  againLine, ranOut, registrableAgain, screenOfEdit, type Stored, unsent, waitsToSign,
} from "../src/screens/names.ts"
import type { CodeRecord, OrderRecord, PendingCode } from "../src/store.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const APP = "0x0B306BF915C4d645ff596e518fAf3F9669b97016"
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const YEAR_S = 365 * 24 * 3600
const CONTACT = "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7p"
const CHANNEL = "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2J"

function registration(change: Partial<RegistrationView> = {}): RegistrationView {
  return {
    ...CHAIN, id: "reg-1", version: 1, phase: "unpaid", labelHash: "0x4f1b", label: null, owner: OWNER, commitment: "0x9c11", sealed: "sealed-box", years: 2,
    duration: 2 * YEAR_S, price: 1500, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, unread: [], expiresAt: null, error: null, ...change,
  }
}

const invoice = (change: Partial<InvoiceView> = {}, reg: Partial<RegistrationView> = {}): InvoiceView => ({
  invoiceId: "inv-1", status: "open", amount: 1500, currency: "usd", expiresAt: "2026-10-17T12:30:00Z", kind: "name", registration: registration(reg),
  address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", cryptoAmount: "0.00025", cryptoCurrency: "btc", cryptoAmountPaid: "0", cryptoAmountDue: "0.00025",
  paidInFull: false, requiredConfirmations: 1, ...change,
})

function record(change: Partial<OrderRecord> = {}): OrderRecord {
  return {
    registrationId: "reg-1", invoiceId: "inv-1", label: "alice", ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: OWNER, contact: "", channel: "",
    method: "btc", paid: 1500, years: 2, request: { duration: 2 * 365 * 86400, labelHash: "0x4f1b", length: 5, owner: OWNER, commitment: "0x9c11", sealed: "sealed-box" },
    tld: "simplex", createdAt: "2026-10-17T11:59:00Z", ...change,
  }
}

const code = (c: string): CodeRecord => ({ code: c, minLength: 6, years: 2, addedAt: "2026-10-17T11:00:00Z" })
const pending = (ownerCode: string): PendingCode => ({ ownerCode, label: "bob", tld: "simplex", createdAt: "2026-10-17T11:30:00Z" })

const registered = (records: { contact: string; channel: string } | null = { contact: CONTACT, channel: "" }, change: Partial<Extract<SearchAnswer, { status: "registered" }>> = {}): SearchAnswer =>
  ({ status: "registered", entities: [], records, owner: OWNER, recordsNonce: 3, expiresAt: NOW / 1000 + 2 * YEAR_S, tld: "simplex", ...change })
const available: SearchAnswer = { status: "available", price: 1500, currency: "usd", years: 2, termStart: Date.UTC(2027, 0, 1) / 1000, ...CHAIN }
const registeredView = (change: Partial<RegistrationView> = {}) => registration({ phase: "registered", label: "alice", registerTx: "0xe9", expiresAt: NOW / 1000 + 2 * YEAR_S, ...change })

const stored = (change: Partial<Stored> = {}): Stored => ({ orders: [], pending: [], codes: [], canPersist: true, ...change })
const WAIT = { until: NOW + 5000, lead: NO_LEAD }
const storedEvent = (change: Partial<Stored> = {}, hold: Hold | null = null): ListEvent => ({ type: "stored", ...stored(change), hold })
const list = (change: Partial<Stored> = {}, state: Partial<ListState> = {}): ListState => ({ ...initialList(stored(change), null, {}, {}, NOW), ...state })

describe("list helpers", () => {
  it("lapsed: a registered name past its expiry, or one the search finds available again, is over", () => {
    const view = registeredView()
    expect(lapsed({ view, answer: registered() }, NOW)).toBe(false)
    expect(lapsed({ view, answer: registered() }, NOW + 3 * YEAR_S * 1000)).toBe(true)
    expect(lapsed({ view, answer: available }, NOW)).toBe(true)
    expect(lapsed({ view: registration({ phase: "committed" }), answer: available }, NOW)).toBe(false)
  })
  it("registrableAgain: free now once the search finds it available", () => {
    expect(registrableAgain(NOW / 1000 - GRACE_S - 1, available, NOW)).toEqual({ when: "now" })
  })
  it("registrableAgain: within the grace period, from the moment it ends, while the chain still has it registered", () => {
    const expiresAt = NOW / 1000 - 1
    expect(registrableAgain(expiresAt, registered(), NOW)).toEqual({ when: "from", at: expiresAt + GRACE_S })
    expect(registrableAgain(expiresAt, registered(), (expiresAt + GRACE_S) * 1000 - 1)).toEqual({ when: "from", at: expiresAt + GRACE_S })
  })
  it("registrableAgain: taken once the grace period is over and the name is registered again, or with no expiry to count from", () => {
    const expiresAt = NOW / 1000 - GRACE_S
    expect(registrableAgain(expiresAt, registered(undefined, { owner: APP }), NOW)).toEqual({ when: "taken" })
    expect(registrableAgain(null, registered(undefined, { owner: APP }), NOW)).toEqual({ when: "taken" })
  })
  it("ranOut and againLine say when a name ran out and when it can be registered again, as the edit page and search show it", () => {
    const expiresAt = Date.parse("2028-11-16T12:00:00Z") / 1000
    expect(ranOut(expiresAt)).toBe("Its registration ran out on 16\u00a0November 2028.")
    expect(ranOut(null)).toBe("Its registration ran out.")
    expect(againLine(expiresAt, registered(), expiresAt * 1000 + 1000)).toBe("It can be registered again from 14\u00a0February 2029.")
    expect(againLine(expiresAt, available, expiresAt * 1000)).toBe("Search it to register it again.")
    expect(againLine(expiresAt, registered(undefined, { owner: APP }), (expiresAt + GRACE_S) * 1000)).toBe("It has been registered again since.")
  })
  it("waitsToSign: a commit whose wait is over and whose name is still hidden", () => {
    const view = registration({ phase: "committed", revealAfter: NOW / 1000 - 1 })
    expect(waitsToSign(view, NOW)).toBe(true)
    expect(waitsToSign(view, NOW - 2000)).toBe(false)
    expect(waitsToSign({ ...view, label: "alice" }, NOW)).toBe(false)
    expect(waitsToSign({ ...view, revealAfter: null }, NOW)).toBe(false)
  })
  it("phaseChip words each phase of an order as its page does", () => {
    const cases: [string, RegistrationView, InvoiceView | null, OrderRecord, [string, string]][] = [
      ["a commit waiting for this browser", registration({ phase: "committed", revealAfter: NOW / 1000 - 1 }), null, record(), ["Open to finish", "warn"]],
      ["an expired invoice", registration(), invoice({ status: "expired" }), record(), ["Invoice expired", "bad"]],
      ["an expired invoice money reached", registration(), invoice({ status: "expired", cryptoAmountPaid: "0.0001" }), record(), ["Invoice expired", "warn"]],
      ["a cancelled invoice that closed", registration(), invoice({ status: "expired" }), record({ cancelled: true }), ["Invoice cancelled", "bad"]],
      ["a cancel the service still shows open", registration(), invoice(), record({ cancelled: true }), ["Invoice cancelled", "warn"]],
      ["a payment after the invoice closed", registration(), invoice({ status: "paid" }), record(), ["Paid late", "warn"]],
      ["a payment in full", registration(), invoice({ paidInFull: true }), record(), ["Confirming payment", "warn"]],
      ["a card submitted", registration(), invoice({ cryptoCurrency: "card" }), record({ cardSubmittedAt: "2026-10-17T11:59:30Z" }), ["Confirming payment", "warn"]],
      ["part of a payment", registration(), invoice({ cryptoAmountPaid: "0.0001" }), record(), ["Waiting for the rest", "warn"]],
      ["nothing paid", registration(), invoice(), record(), ["Waiting for payment", "warn"]],
      ["a registration under way", registration({ phase: "registering" }), null, record(), ["Registering", "brand"]],
      ["a registered name", registeredView(), null, record(), ["Registered", "ok"]],
      ["a name taken first", registration({ phase: "taken" }), null, record(), ["Taken first", "warn"]],
      ["a failed registration", registration({ phase: "failed" }), null, record(), ["Not registered", "bad"]],
      ["an order turned into a code", registration({ phase: "code_issued" }), null, record(), ["Code taken", "ok"]],
    ]
    for (const [what, view, inv, o, chip] of cases) expect(phaseChip(view, inv, o, NOW), what).toEqual(chip)
  })
  it("CODE_CHIPS words every state a code can be in", () => {
    expect(Object.keys(CODE_CHIPS).sort()).toEqual(["expired", "reserved", "revoked", "unpaid", "unused", "used"])
  })
  it("editable: a name in the app's wallet, or pointed at another resolver, is not edited here", () => {
    expect(editable(registered(), OWNER)).toBe(true)
    expect(editable(registered(), OWNER.toLowerCase())).toBe(true)
    expect(editable(registered(undefined, { owner: APP }), OWNER)).toBe(false)
    expect(editable(registered(null), OWNER)).toBe(false)
    expect(editable(registered(undefined, { owner: undefined }), OWNER)).toBe(true)
    expect(editable(available, OWNER)).toBe(true)
  })
  it("listedOrders leaves out a replaced invoice until its read says money reached it", () => {
    const replaced = record({ registrationId: "reg-old", replacedBy: "/?order=inv-2" })
    const s = list({ orders: [record(), replaced] })
    expect(listedOrders(s).map((o) => o.registrationId)).toEqual(["reg-1"])
    const late = reduceList(s, { type: "row-read", id: "reg-old", view: registration({ id: "reg-old" }), invoice: invoice({ status: "paid" }), now: NOW })
    expect(listedOrders(late).map((o) => o.registrationId)).toEqual(["reg-1", "reg-old"])
    const empty = reduceList(s, { type: "row-read", id: "reg-old", view: registration({ id: "reg-old" }), invoice: invoice({ status: "expired" }), now: NOW })
    expect(listedOrders(empty).map((o) => o.registrationId)).toEqual(["reg-1"])
  })
  it("listedOrders puts the order that replaced another in the replaced one's place", () => {
    const newer = record({ registrationId: "reg-2", invoiceId: "inv-2", createdAt: "2026-10-17T11:59:30Z" })
    const other = record({ registrationId: "reg-b", invoiceId: "inv-b", createdAt: "2026-10-17T11:59:10Z" })
    const replaced = record({ registrationId: "reg-1", replacedBy: "/?order=inv-2" })
    expect(listedOrders(list({ orders: [newer, other, replaced] })).map((o) => o.registrationId)).toEqual(["reg-b", "reg-2"])
    const newest = record({ registrationId: "reg-3", invoiceId: "inv-3", createdAt: "2026-10-17T11:59:50Z" })
    const chain = [newest, { ...newer, replacedBy: "/?order=inv-3" }, other, replaced]
    expect(listedOrders(list({ orders: chain })).map((o) => o.registrationId)).toEqual(["reg-b", "reg-3"])
    const late = reduceList(list({ orders: [newer, other, replaced] }), { type: "row-read", id: "reg-1", view: registration(), invoice: invoice({ status: "paid" }), now: NOW })
    expect(listedOrders(late).map((o) => o.registrationId)).toEqual(["reg-2", "reg-b", "reg-1"])
  })
  it("a listed order that becomes replaced leaves the list until a fresh read says money reached it", () => {
    const open = reduceList(list({ orders: [record()] }), { type: "row-read", id: "reg-1", view: registration(), invoice: invoice(), now: NOW })
    expect(listedOrders(open).map((o) => o.registrationId)).toEqual(["reg-1"])
    const replaced = reduceList(open, storedEvent({ orders: [record({ replacedBy: "/?order=inv-2" })] }))
    expect(replaced.seen).toEqual({})
    expect(listedOrders(replaced)).toEqual([])
    const late = reduceList(replaced, { type: "row-read", id: "reg-1", view: registration(), invoice: invoice({ status: "paid" }), now: NOW })
    expect(listedOrders(reduceList(late, storedEvent({ orders: late.orders }))).map((o) => o.registrationId)).toEqual(["reg-1"])
  })
  it("a read begun before another tab replaced the order lists it again only for money that reached it, whichever lands first", () => {
    const open = reduceList(list({ orders: [record()] }), { type: "row-read", id: "reg-1", view: registration(), invoice: invoice(), now: NOW })
    const replacedNow = storedEvent({ orders: [record({ replacedBy: "/?order=inv-2" })] })
    const staleRead = { type: "row-read", id: "reg-1", view: registration(), invoice: invoice(), now: NOW + 1000 } as const
    expect(listedOrders(reduceList(reduceList(open, replacedNow), staleRead))).toEqual([])
    expect(listedOrders(reduceList(reduceList(open, staleRead), replacedNow))).toEqual([])
    const paidRead = { ...staleRead, invoice: invoice({ status: "expired", cryptoAmountPaid: "0.0001" }) }
    expect(listedOrders(reduceList(reduceList(open, replacedNow), paidRead)).map((o) => o.registrationId)).toEqual(["reg-1"])
  })
  it("hasRecords: any order, pending code or code", () => {
    expect(hasRecords(list())).toBe(false)
    expect(hasRecords(list({ pending: [pending("SN-P")] }))).toBe(true)
    expect(hasRecords(list({ codes: [code("SN6-A")] }))).toBe(true)
    expect(hasRecords(list({ orders: [record({ replacedBy: "/?order=inv-2" })] }))).toBe(true)
  })
})

describe("list", () => {
  const view = registration({ phase: "committing" })
  const one = list({ orders: [record()], codes: [code("SN6-A")], pending: [pending("SN-P")] })

  it("initialList starts from what the rows read last time, for the records still kept, and checks again a code that could not be", () => {
    const seen = { "reg-1": { view, invoice: null }, "reg-gone": { view, invoice: null } }
    const s = initialList(stored({ orders: [record()], codes: [code("SN6-A"), code("SN6-B")] }), null, seen, { "SN6-A": "used", "SN6-B": "unchecked", "SN6-gone": "unused" }, NOW)
    expect(s.seen).toEqual({ "reg-1": { view, invoice: null } })
    const replaced = initialList(stored({ orders: [record({ replacedBy: "/?order=inv-2" })] }), null, { "reg-1": { view, invoice: invoice() } }, {}, NOW)
    expect(replaced.seen).toEqual({})
    expect(listedOrders(replaced)).toEqual([])
    expect(s.checked).toEqual({ "SN6-A": "used" })
    expect(s).toMatchObject({ now: NOW, asking: false, hold: null, finding: {}, unread: [] })
    expect(initialList(stored({ pending: [pending("SN-P")] }), WAIT, {}, {}, NOW).hold).toEqual(WAIT)
  })
  it("stored takes the records another tab or this one wrote, and forgets what was read about records gone", () => {
    const read = reduceList(reduceList(one, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW }), { type: "code-read", code: "SN6-A", state: "unused" })
    const found = reduceList(read, { type: "find-ended", ownerCode: "SN-P", outcome: "none" })
    const next = reduceList(found, storedEvent({ codes: [code("SN6-B")], canPersist: false }, WAIT))
    expect(next).toMatchObject({ orders: [], pending: [], codes: [code("SN6-B")], canPersist: false, hold: WAIT, seen: {}, checked: {}, finding: {}, unread: [] })
  })
  it("stored with nothing left takes the forget question away", () => {
    const asking = reduceList(one, { type: "forget-asked" })
    expect(reduceList(asking, storedEvent()).asking).toBe(false)
    expect(reduceList(asking, storedEvent({ codes: [code("SN6-A")] })).asking).toBe(true)
  })
  it("row-read keeps the read, the time, and a registered name's records until they are read again", () => {
    const answer = registered()
    const first = reduceList(one, { type: "row-read", id: "reg-1", view: registeredView(), invoice: null, now: NOW + 1000 })
    const withAnswer = reduceList(first, { type: "row-answered", id: "reg-1", answer })
    expect(withAnswer.seen["reg-1"]).toEqual({ view: registeredView(), invoice: null, answer })
    const again = reduceList(withAnswer, { type: "row-read", id: "reg-1", view: registeredView(), invoice: null, now: NOW + 2000 })
    expect(again.seen["reg-1"].answer).toBe(answer)
    expect(again.now).toBe(NOW + 2000)
    const notRegistered = reduceList({ ...one, seen: { "reg-1": { view, invoice: null, answer } } }, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW })
    expect(notRegistered.seen["reg-1"].answer).toBeUndefined()
  })
  it("row-read clears the row's failed read", () => {
    const failed = reduceList(one, { type: "row-unread", id: "reg-1" })
    expect(failed.unread).toEqual(["reg-1"])
    expect(reduceList(failed, { type: "row-unread", id: "reg-1" }).unread).toEqual(["reg-1"])
    expect(reduceList(failed, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW }).unread).toEqual([])
  })
  it("an answer about a record no longer kept changes nothing", () => {
    expect(reduceList(one, { type: "row-read", id: "reg-gone", view, invoice: null, now: NOW })).toBe(one)
    expect(reduceList(one, { type: "row-answered", id: "reg-1", answer: null })).toBe(one)
    expect(reduceList(one, { type: "row-unread", id: "reg-gone" })).toBe(one)
    expect(reduceList(one, { type: "code-read", code: "SN6-gone", state: "used" })).toBe(one)
    expect(reduceList(one, { type: "find-started", ownerCode: "SN-gone" })).toBe(one)
    expect(reduceList(one, { type: "find-ended", ownerCode: "SN-gone", outcome: "none" })).toBe(one)
  })
  it("code-read keeps the code's state, or that it could not be checked", () => {
    expect(reduceList(one, { type: "code-read", code: "SN6-A", state: "reserved" }).checked).toEqual({ "SN6-A": "reserved" })
    expect(reduceList(one, { type: "code-read", code: "SN6-A", state: "unchecked" }).checked).toEqual({ "SN6-A": "unchecked" })
  })
  it("find-started marks the lookup at work; find-ended keeps what it found", () => {
    const finding = reduceList(one, { type: "find-started", ownerCode: "SN-P" })
    expect(finding.finding).toEqual({ "SN-P": "finding" })
    expect(reduceList(finding, { type: "find-ended", ownerCode: "SN-P", outcome: "none" }).finding).toEqual({ "SN-P": "none" })
    expect(reduceList(finding, { type: "find-ended", ownerCode: "SN-P", outcome: "unchecked" }).finding).toEqual({ "SN-P": "unchecked" })
  })
  it("find-held ends the lookup and holds every Find until hold-ended, a shorter wait never cutting a longer one", () => {
    const held = reduceList(reduceList(one, { type: "find-started", ownerCode: "SN-P" }), { type: "find-held", ownerCode: "SN-P", until: NOW + 5000 })
    expect(held).toMatchObject({ finding: {}, hold: WAIT })
    expect(reduceList(held, { type: "find-held", ownerCode: "SN-P", until: NOW + 1000 }).hold).toEqual(WAIT)
    expect(reduceList(held, { type: "hold-ended" }).hold).toBeNull()
  })
  it("forget-asked asks only while there is something to forget; forget-kept takes the question away", () => {
    const asking = reduceList(one, { type: "forget-asked" })
    expect(asking.asking).toBe(true)
    expect(reduceList(asking, { type: "forget-kept" }).asking).toBe(false)
    expect(reduceList(list(), { type: "forget-asked" }).asking).toBe(false)
  })
  it("forget-confirmed forgets every record and everything read about them", () => {
    const read = reduceList(reduceList(one, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW }), { type: "forget-asked" })
    expect(reduceList(read, { type: "forget-confirmed" })).toEqual({ ...list({}, { now: NOW }), canPersist: true })
  })
  it("the same events give the same list, whatever the rows' reads answer in between", () => {
    const events = [
      { type: "row-read", id: "reg-1", view, invoice: null, now: NOW },
      { type: "code-read", code: "SN6-A", state: "unused" },
      { type: "find-started", ownerCode: "SN-P" },
    ] as const
    const a = events.reduce(reduceList, one)
    const b = [events[2], events[0], events[1]].reduce(reduceList, one)
    expect(a).toEqual(b)
  })
})

describe("show code", () => {
  const two = stored({ orders: [record(), record({ registrationId: "reg-2" })] })
  const shown = (id: string) => reduceList(initialList(two, null, {}, {}, NOW), { type: "code-toggled", id })
  it("starts with no row expanded", () => {
    expect(initialList(two, null, {}, {}, NOW).shownCode).toBeNull()
  })
  it("expands one row at a time and collapses it when toggled again", () => {
    const one = shown("reg-1")
    expect(one.shownCode).toBe("reg-1")
    expect(reduceList(one, { type: "code-toggled", id: "reg-2" }).shownCode).toBe("reg-2")
    expect(reduceList(one, { type: "code-toggled", id: "reg-1" }).shownCode).toBeNull()
  })
  it("a row no longer stored is not expanded, and a toggle for an unknown row changes nothing", () => {
    expect(reduceList(shown("reg-2"), { type: "stored", ...two, orders: [record()], hold: null }).shownCode).toBeNull()
    expect(reduceList(shown("reg-2"), { type: "stored", ...two, hold: null }).shownCode).toBe("reg-2")
    expect(reduceList(shown("reg-1"), { type: "code-toggled", id: "reg-gone" }).shownCode).toBe("reg-1")
  })
  it("forgetting everything collapses the row", () => {
    expect(reduceList(shown("reg-1"), { type: "forget-confirmed" }).shownCode).toBeNull()
  })
})

describe("restore", () => {
  const start = initialRestore(null)
  it("starts held when a wait met elsewhere in the tab is still on", () => {
    expect(initialRestore({ until: NOW + 5000, lead: NO_LEAD })).toEqual({ busy: false, refusal: null, hold: { until: NOW + 5000, lead: NO_LEAD } })
    expect(start).toEqual({ busy: false, refusal: null, hold: null })
  })
  it("find-started marks the lookup at work and clears the last refusal", () => {
    expect(reduceRestore({ ...start, refusal: "unasked" }, { type: "find-started" })).toEqual({ busy: true, refusal: null, hold: null })
  })
  it("refused ends the lookup with why", () => {
    expect(reduceRestore({ ...start, busy: true }, { type: "refused", why: "none" })).toEqual({ busy: false, refusal: "none", hold: null })
  })
  it("edited takes the refusal away, unless the tab is waiting", () => {
    expect(reduceRestore({ ...start, refusal: "none" }, { type: "edited" })).toEqual(start)
    const held = { ...start, hold: { until: NOW + 5000, lead: "Your code is fine. " } }
    expect(reduceRestore(held, { type: "edited" })).toBe(held)
  })
  it("held ends the lookup and holds it with its words; hold-ended lets it go", () => {
    const held = reduceRestore({ ...start, busy: true }, { type: "held", until: NOW + 5000, lead: "Your code is fine. " })
    expect(held).toEqual({ busy: false, refusal: null, hold: { until: NOW + 5000, lead: "Your code is fine. " } })
    expect(reduceRestore(held, { type: "hold-ended" })).toEqual(start)
  })
  it("REFUSALS: a refusal of the code itself waits for an edit; one of the service can be tried again", () => {
    expect(Object.entries(REFUSALS).filter(([, r]) => r.again).map(([k]) => k)).toEqual(["unasked"])
  })
})

describe("edit", () => {
  const opened = initialEdit("reg-1", record({ invoiceId: null, method: "code" }))
  const answered = (s: EditState, answer: SearchAnswer, view = registeredView(), change: Partial<Extract<EditEvent, { type: "answered" }>> = {}): EditState =>
    reduceEdit(s, { type: "answered", view, answer, record: s.record!, now: NOW, hold: null, ...change })
  const form = (s: EditState): EditForm => s.form!
  const editing = answered(opened, registered())

  const STATES: Record<EditKind, EditState> = {
    "edit-no-code": initialEdit("reg-1", null),
    "edit-unreadable": reduceEdit(opened, { type: "read-failed" }),
    "edit-expired": answered(opened, available),
    "edit-in-app": answered(opened, registered(undefined, { owner: APP })),
    "edit-elsewhere": answered(opened, registered(null)),
    "edit-not-registered": answered(opened, { status: "reserved" }, registration({ phase: "committed" })),
    edit: editing,
  }

  describe("screenOfEdit", () => {
    const cases: [string, EditState, EditKind][] = [
      ["a name whose code is not in this browser", STATES["edit-no-code"], "edit-no-code"],
      ["an order with no record at all", initialEdit("reg-1", null), "edit-no-code"],
      ["a name not read yet", opened, "edit-unreadable"],
      ["a name whose read failed", STATES["edit-unreadable"], "edit-unreadable"],
      ["a name past its expiry", answered(opened, registered(), registeredView({ expiresAt: NOW / 1000 - 1 })), "edit-expired"],
      ["a name registered again by someone else", STATES["edit-expired"], "edit-expired"],
      ["a name moved to the app's wallet", STATES["edit-in-app"], "edit-in-app"],
      ["a name pointed at another resolver", STATES["edit-elsewhere"], "edit-elsewhere"],
      ["a name still being registered", STATES["edit-not-registered"], "edit-not-registered"],
      ["a registered name without a records nonce", answered(opened, registered(undefined, { recordsNonce: null })), "edit-not-registered"],
      ["a registered name with its links", STATES.edit, "edit"],
    ]
    it.each(cases)("%s", (_, state, kind) => {
      expect(screenOfEdit(state)).toBe(kind)
    })
  })

  describe("reduceEdit", () => {
    it("answered opens the form with the chain's links and nonce, held when the tab is waiting", () => {
      expect(form(editing)).toEqual({
        current: { contact: CONTACT, channel: "" }, values: { contact: CONTACT, channel: "" }, nonce: 3, changes: {}, sent: [],
        saving: false, unanswered: false, settled: false, result: null, hold: null,
      })
      expect(form(answered(opened, registered(), undefined, { hold: { until: NOW + 5000, lead: NO_LEAD } })).hold).toEqual({ until: NOW + 5000, lead: NO_LEAD })
      expect(STATES["edit-in-app"].form).toBeNull()
    })
    it("answered again keeps the form as it is typed", () => {
      const typed = reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL })
      expect(form(answered(typed, registered(undefined, { recordsNonce: 9 }))).values.channel).toBe(CHANNEL)
    })
    it("opened changes nothing", () => {
      expect(reduceEdit(STATES["edit-no-code"], { type: "opened" })).toBe(STATES["edit-no-code"])
    })
    it("read-started marks a read under way; read-failed ends it and counts the failure, answered ends it", () => {
      const reading = reduceEdit(STATES["edit-unreadable"], { type: "read-started" })
      expect(reading).toMatchObject({ reading: true, failures: 1 })
      expect(reduceEdit(reading, { type: "read-failed" })).toMatchObject({ reading: false, failures: 2 })
      expect(answered(reading, registered()).reading).toBe(false)
    })
    it("field-changed keeps the value, takes away an answer it no longer stands for and lets Save go again", () => {
      const saved = { ...editing, form: { ...form(editing), result: "saved" as const, settled: true } }
      const typed = reduceEdit(saved, { type: "field-changed", kind: "channel", value: CHANNEL })
      expect(form(typed)).toMatchObject({ values: { contact: CONTACT, channel: CHANNEL }, result: null, settled: false })
      const moved = { ...editing, form: { ...form(editing), values: { contact: "", channel: "" }, result: "moved" as const } }
      expect(form(reduceEdit(moved, { type: "field-changed", kind: "contact", value: CONTACT }))).toMatchObject({ values: { contact: CONTACT, channel: "" }, result: "moved" })
    })
    it("field-changed to the value it had changes nothing", () => {
      expect(reduceEdit(editing, { type: "field-changed", kind: "contact", value: CONTACT })).toBe(editing)
    })
    it("field-changed while a save is on its way, unanswered or held keeps only the value", () => {
      for (const block of [{ saving: true }, { unanswered: true }, { hold: { until: NOW + 5000, lead: NO_LEAD } }]) {
        const s = { ...editing, form: { ...form(editing), ...block, result: "sending" as const } }
        expect(form(reduceEdit(s, { type: "field-changed", kind: "channel", value: CHANNEL }))).toEqual({ ...s.form, values: { contact: CONTACT, channel: CHANNEL } })
      }
    })
    it("save-started with nothing changed says so; with changes it sends them", () => {
      expect(form(reduceEdit(editing, { type: "save-started" }))).toMatchObject({ saving: false, result: "nothing" })
      const typed = reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL })
      expect(form(reduceEdit(typed, { type: "save-started" }))).toMatchObject({ saving: true, result: "sending", changes: { channel: CHANNEL }, sent: [] })
    })
    it("link-saved spends a nonce and takes the link as on chain", () => {
      const sending = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      expect(form(reduceEdit(sending, { type: "link-saved", kind: "channel" }))).toMatchObject({ nonce: 4, sent: ["channel"], current: { contact: CONTACT, channel: CHANNEL } })
    })
    it("save-done says the links are saved, and Save stays off with nothing left to save", () => {
      const sending = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      const done = reduceEdit(reduceEdit(sending, { type: "link-saved", kind: "channel" }), { type: "save-done" })
      expect(form(done)).toMatchObject({ saving: false, result: "saved", settled: true })
      const typedMeanwhile = reduceEdit(reduceEdit(sending, { type: "link-saved", kind: "channel" }), { type: "field-changed", kind: "contact", value: "" })
      expect(form(reduceEdit(typedMeanwhile, { type: "save-done" }))).toMatchObject({ result: "saved", settled: false })
    })
    it("save-unanswered keeps Save off until the page is reloaded", () => {
      const sending = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      expect(form(reduceEdit(sending, { type: "save-unanswered" }))).toMatchObject({ saving: false, unanswered: true, result: "unanswered" })
    })
    it("save-held holds Save with what was and was not saved; hold-ended lets it go", () => {
      const both = reduceEdit(reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "contact", value: "" }), { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      const held = reduceEdit(reduceEdit(both, { type: "link-saved", kind: "contact" }), { type: "save-held", until: NOW + 5000 })
      expect(form(held)).toMatchObject({ saving: false, result: null, hold: { until: NOW + 5000, lead: "The address was saved; the channel was not. " } })
      expect(form(reduceEdit(held, { type: "hold-ended" })).hold).toBeNull()
    })
    it("save-refused after the nonce moved takes the chain's nonce and links", () => {
      const sending = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      const moved = reduceEdit(sending, { type: "save-refused", moved: { nonce: 7, records: { contact: "", channel: CHANNEL } } })
      expect(form(moved)).toMatchObject({ saving: false, result: "moved", nonce: 7, current: { contact: "", channel: CHANNEL } })
      expect(form(reduceEdit(sending, { type: "save-refused", moved: { nonce: 7, records: null } }))).toMatchObject({ nonce: 7, current: { contact: CONTACT, channel: "" } })
      expect(form(reduceEdit(sending, { type: "save-refused", moved: null }))).toMatchObject({ saving: false, result: "refused", nonce: 3 })
    })
    it("form events reach no form on a page that has none", () => {
      const s = STATES["edit-in-app"]
      for (const event of [{ type: "save-started" }, { type: "field-changed", kind: "contact", value: "x" }, { type: "hold-ended" }] as EditEvent[]) expect(reduceEdit(s, event)).toBe(s)
    })
  })

  describe("form helpers", () => {
    const f = (change: Partial<EditForm>): EditForm => ({ ...form(editing), ...change })
    it("changesOf lists the links that differ from the chain's", () => {
      expect(changesOf(f({}))).toEqual({})
      expect(changesOf(f({ values: { contact: "", channel: CHANNEL } }))).toEqual({ contact: "", channel: CHANNEL })
    })
    it("unsent names the first link still to send", () => {
      expect(unsent({ contact: "", channel: CHANNEL }, ["contact"])).toBe("channel")
      expect(unsent({ contact: "" }, ["contact"])).toBeUndefined()
    })
    it("notSaved says which link reached the chain", () => {
      expect(notSaved(f({ changes: { contact: "", channel: CHANNEL }, sent: ["contact"] }))).toBe("The address was saved; the channel was not.")
      expect(notSaved(f({ changes: { channel: CHANNEL }, sent: [] }))).toBe("The links were not saved.")
      expect(notSaved(f({ changes: { channel: CHANNEL }, sent: ["channel"] }))).toBe("The links were not saved.")
    })
  })
})
