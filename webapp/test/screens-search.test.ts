import { describe, expect, it } from "vitest"
import type { SearchAnswer } from "../src/api.ts"
import { type Hold, NO_LEAD } from "../src/screens/hold.ts"
import {
  initialSearch, type Opening, reduce, REGISTER_LEAD, returnedTo, searchDue, type SearchEvent, type SearchKind, type SearchState, screenOf,
} from "../src/screens/search.ts"
import type { OrderRecord } from "../src/store.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const AVAILABLE: SearchAnswer = { status: "available", price: 1500, currency: "usd", years: 2, ...CHAIN }
const TAKEN: SearchAnswer = { status: "registered", entities: [], owner: OWNER, tld: "simplex" }
const MINE = { registrationId: "reg-1", withCode: true }

function record(change: Partial<OrderRecord> = {}): OrderRecord {
  return {
    registrationId: "reg-1", invoiceId: "inv-1", label: "alice1", ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: OWNER, contact: "", channel: "",
    method: "btc", paid: 1500, years: 2, secret: "0x01", request: { labelHash: "0x4f1b", length: 6, owner: OWNER, commitment: "0x9c11", sealed: "sealed-box" },
    tld: "simplex", createdAt: "2026-10-17T11:59:00Z", ...change,
  }
}

const openedEvent = (change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}): Extract<SearchEvent, { type: "opened" }> =>
  ({ type: "opened", opening: "plain", name: "", fromApp: null, retarget: null, hold: null, ...change })
const open = (change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}) => reduce(initialSearch(), openedEvent(change))
const run = (s: SearchState, ...events: SearchEvent[]) => events.reduce(reduce, s)
const wait = (until: number): Hold => ({ until, lead: NO_LEAD })
const searchedEvent = (label: string, hold: Hold | null = null): SearchEvent => ({ type: "searched", label, hold })
const answered = (s: SearchState, answer: SearchAnswer = AVAILABLE, label = s.searching!.label): SearchEvent => ({ type: "answered", seq: s.seq, label, answer, mine: null, now: NOW })
function shown(label = "alice1", answer: SearchAnswer = AVAILABLE, change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}): SearchState {
  const s = open({ name: label, ...change })
  const searching = reduce(s, searchedEvent(label))
  return reduce(searching, answered(searching, answer))
}

describe("screenOf", () => {
  const cases: [Opening, SearchKind][] = [["plain", "search:plain"], ["fromApp", "search:fromApp"], ["retarget", "search:retarget"], ["bad-app-link", "status:bad-app-link"]]
  it.each(cases)("a page opened %s shows %s", (opening, kind) => {
    expect(screenOf(open({ opening }))).toBe(kind)
  })
  it("a retarget page whose order went elsewhere stays the retarget page", () => {
    const s = open({ opening: "retarget", retarget: record() })
    expect(screenOf(reduce(s, { type: "retarget-read", record: record(), moved: { to: "code", url: "/?order=inv-1" } }))).toBe("search:retarget")
  })
})

describe("searchDue", () => {
  it("is due for a name the link names and the field holds, not searched yet", () => {
    expect(searchDue(open({ name: "alice1" }))).toBe(true)
    expect(searchDue(open())).toBe(false)
    expect(searchDue(shown())).toBe(false)
  })
  it("is not due while the search is paused, or once another name is typed", () => {
    expect(searchDue(open({ name: "alice1", hold: wait(NOW + 5000) }))).toBe(false)
    expect(searchDue(reduce(open({ name: "alice1" }), { type: "typed", text: "bob" }))).toBe(false)
  })
  it("is due for a new name the link names on a page drawn again", () => {
    expect(searchDue(reduce(shown(), openedEvent({ name: "carol1" })))).toBe(true)
  })
  it("folds what is typed as a search does", () => {
    expect(searchDue(reduce(open({ name: "alice1" }), { type: "typed", text: "alice1.simplex" }))).toBe(true)
  })
})

describe("reduce: opened", () => {
  it("a page opened anew fills the field with the link's name", () => {
    const s = open({ name: "alice1" })
    expect(s).toMatchObject({ opening: "plain", name: "alice1", typed: "alice1", searched: null, answer: null, hold: null, paused: false })
  })
  it("keeps the order a retarget search moves, and the app's wallet", () => {
    expect(open({ opening: "retarget", retarget: record() }).retarget).toEqual(record())
    expect(open({ opening: "fromApp", fromApp: OWNER }).fromApp).toBe(OWNER)
  })
  it("drawn again, a name searched keeps its answer and the field its name", () => {
    const s = shown()
    const next = reduce(s, openedEvent({ name: "alice1" }))
    expect(next).toMatchObject({ typed: "alice1", searched: "alice1", answer: s.answer })
  })
  it("drawn again with a name typed over the one searched, the answer gives way and the name typed stays", () => {
    const s = reduce(shown(), { type: "typed", text: "bobby1" })
    const next = reduce(s, openedEvent({ name: "alice1" }))
    expect(next).toMatchObject({ typed: "bobby1", answer: null, searching: null, bad: false })
    expect(next.seq).toBeGreaterThan(s.seq)
  })
  it("drawn again during a search for the name, the search goes on", () => {
    const s = reduce(open({ name: "alice1" }), searchedEvent("alice1"))
    const next = reduce(s, openedEvent({ name: "alice1" }))
    expect(next).toMatchObject({ seq: s.seq, searching: { label: "alice1" } })
    expect(reduce(next, answered(s)).answer).toMatchObject({ kind: "found", label: "alice1" })
  })
  it("drawn again, the refusal its register showed is done with, and a register under way goes on", () => {
    const s = run(shown(), { type: "register-started" })
    expect(reduce(s, openedEvent({ name: "alice1" })).register).toEqual({ busy: true, refusal: null })
    const refused = reduce(s, { type: "register-refused", refusal: { why: "failed" } })
    expect(reduce(refused, openedEvent({ name: "alice1" })).register).toEqual({ busy: false, refusal: null })
  })
  it("a wait met elsewhere in the tab pauses the search, dropping what was shown", () => {
    const s = open({ name: "alice1", hold: wait(NOW + 5000) })
    expect(s).toMatchObject({ hold: { until: NOW + 5000, lead: NO_LEAD }, paused: true, answer: null })
    const later = reduce(shown(), openedEvent({ name: "alice1", hold: wait(NOW + 5000) }))
    expect(later).toMatchObject({ paused: true, answer: null, searching: null })
  })
  it("a wait the page knows of keeps what the page shows, and ends only by its own event", () => {
    const held = reduce(shown(), { type: "register-held", until: NOW + 5000 })
    expect(reduce(held, openedEvent({ name: "alice1", hold: wait(NOW + 5000) }))).toMatchObject({ paused: false, answer: held.answer, hold: held.hold })
    expect(reduce(held, openedEvent({ name: "alice1", hold: null }))).toMatchObject({ hold: held.hold })
  })
  it("an order that went elsewhere stays gone when the page is drawn again", () => {
    const moved = { to: "name" as const, url: "/?order=inv-1", label: "other1", tld: "simplex" }
    const s = reduce(open({ opening: "retarget", retarget: record() }), { type: "retarget-read", record: record(), moved })
    expect(reduce(s, openedEvent({ opening: "retarget", retarget: record() }))).toMatchObject({ retarget: null, moved })
  })
  it("a new name in the link, drawn again, goes into the field", () => {
    expect(reduce(shown(), openedEvent({ name: "carol1" }))).toMatchObject({ name: "carol1", typed: "carol1" })
  })
})

describe("reduce: typing and searching", () => {
  it("typed keeps the text and takes the rules' mark off the box", () => {
    const refused = reduce(open(), searchedEvent("abc"))
    expect(refused.bad).toBe(true)
    expect(reduce(refused, { type: "typed", text: "abcd" })).toMatchObject({ typed: "abcd", bad: false, answer: refused.answer })
  })
  it("searched starts a search, naming it in the link", () => {
    const s = open()
    expect(reduce(s, searchedEvent("alice1"))).toMatchObject({ seq: s.seq + 1, name: "alice1", searched: "alice1", searching: { label: "alice1" } })
  })
  it("a search writes the name it searched back into the field, as typed with \".simplex\" or in its own case", () => {
    const typed = reduce(open(), { type: "typed", text: "mynamehere.simplex" })
    expect(reduce(typed, searchedEvent("mynamehere"))).toMatchObject({ typed: "mynamehere", name: "mynamehere", searched: "mynamehere" })
    const short = reduce(reduce(open(), { type: "typed", text: "abc.simplex" }), searchedEvent("abc"))
    expect(short).toMatchObject({ typed: "abc", answer: { kind: "rule", label: "abc", problem: "short" } })
  })
  it("searched for a name the rules refuse answers it at once and marks the box", () => {
    const short = reduce(open(), searchedEvent("abc"))
    expect(short).toMatchObject({ searching: null, answer: { kind: "rule", label: "abc", problem: "short" }, bad: true, name: "abc" })
    expect(reduce(open(), searchedEvent("bad_name")).answer).toEqual({ kind: "rule", label: "bad_name", problem: "chars" })
    expect(reduce(open(), searchedEvent("a".repeat(64))).answer).toMatchObject({ problem: "long" })
  })
  it("searched with nothing typed, or while paused, changes nothing", () => {
    const s = open()
    expect(reduce(s, searchedEvent(""))).toBe(s)
    const paused = open({ hold: wait(NOW + 5000) })
    expect(reduce(paused, searchedEvent("alice1"))).toBe(paused)
  })
  it("searched during a wait met elsewhere in the tab pauses the search instead", () => {
    const s = shown()
    expect(reduce(s, searchedEvent("bobby1", wait(NOW + 9000)))).toMatchObject({ paused: true, hold: { until: NOW + 9000, lead: NO_LEAD }, answer: null, searching: null, searched: "alice1" })
  })
  it("searched ends the refusal the last register showed", () => {
    const refused = run(shown(), { type: "register-refused", refusal: { why: "taken" } })
    expect(reduce(refused, searchedEvent("bobby1")).register).toEqual({ busy: false, refusal: null })
  })
})

describe("reduce: searching", () => {
  it("a search under way keeps the last answer on screen until the new one comes", () => {
    const found = reduce(reduce(initialSearch(), { type: "searched", label: "bakery", hold: null }), { type: "answered", seq: 1, label: "bakery", answer: AVAILABLE, mine: null, now: 0 })
    const next = reduce({ ...found, typed: "harbour" }, { type: "searched", label: "harbour", hold: null })
    expect(next.searching).toEqual({ label: "harbour" })
    expect(next.answer).toEqual(found.answer)
  })
  it("the opened event carries no code", () => {
    expect(Object.keys(initialSearch())).not.toContain("applied")
  })
})

describe("reduce: answers", () => {
  it("answered shows the answer with what the page knew of it", () => {
    const s = reduce(open(), searchedEvent("alice1"))
    const next = reduce(s, { type: "answered", seq: s.seq, label: "alice1", answer: TAKEN, mine: MINE, now: NOW })
    expect(next).toMatchObject({ searching: null, answer: { kind: "found", label: "alice1", answer: TAKEN, mine: MINE, now: NOW } })
  })
  it("a slower answer to an earlier search never replaces the latest one", () => {
    const first = reduce(open(), searchedEvent("slower1"))
    const second = reduce(first, searchedEvent("bakery"))
    const latest = reduce(second, answered(second, TAKEN))
    expect(reduce(latest, answered(first, AVAILABLE, "slower1"))).toBe(latest)
    const early = reduce(second, answered(first, AVAILABLE, "slower1"))
    expect(early).toBe(second)
    expect(reduce(early, answered(second, TAKEN)).answer).toMatchObject({ label: "bakery" })
  })
  it("an answer for the same name keeps the order it points at; one for another name drops it", () => {
    const pointed = reduce(shown(), { type: "own-order-seen", label: "alice1", url: "/?order=inv-1" })
    const again = reduce(pointed, searchedEvent("alice1"))
    expect(reduce(again, answered(again)).ownOrder).toBe("/?order=inv-1")
    const other = reduce(pointed, searchedEvent("bobby1"))
    expect(reduce(other, answered(other)).ownOrder).toBeNull()
  })
  it("unanswered says the name could not be checked, for the latest search only", () => {
    const first = reduce(open(), searchedEvent("alice1"))
    expect(reduce(first, { type: "unanswered", seq: first.seq })).toMatchObject({ searching: null, answer: { kind: "unchecked" } })
    const second = reduce(first, searchedEvent("bobby1"))
    expect(reduce(second, { type: "unanswered", seq: first.seq })).toBe(second)
  })
  it("search-held pauses the search for the service's wait, for the latest search only", () => {
    const s = reduce(shown(), searchedEvent("bobby1"))
    expect(reduce(s, { type: "search-held", seq: s.seq, until: NOW + 30_000 })).toMatchObject({ paused: true, hold: { until: NOW + 30_000, lead: NO_LEAD }, answer: null, searching: null })
    const later = reduce(s, searchedEvent("carol1"))
    expect(reduce(later, { type: "search-held", seq: s.seq, until: NOW })).toBe(later)
  })
  it("a shorter wait met meanwhile does not cut a longer one", () => {
    const held = reduce(shown(), { type: "register-held", until: NOW + 30_000 })
    expect(reduce(held, searchedEvent("bobby1", wait(NOW + 1000))).hold!.until).toBe(NOW + 30_000)
    const s = reduce(held, { type: "hold-ended" })
    const searching = reduce(s, searchedEvent("bobby1"))
    expect(reduce(run(searching, { type: "register-held", until: NOW + 60_000 }), { type: "search-held", seq: searching.seq, until: NOW + 1000 }).hold!.until).toBe(NOW + 60_000)
  })
  it("hold-ended lifts the pause and the wait", () => {
    const s = open({ name: "alice1", hold: wait(NOW + 5000) })
    expect(reduce(s, { type: "hold-ended" })).toMatchObject({ hold: null, paused: false })
  })
  it("own-order-seen points at the order for the name shown, and not for another", () => {
    const s = shown()
    expect(reduce(s, { type: "own-order-seen", label: "alice1", url: "/?order=inv-1" }).ownOrder).toBe("/?order=inv-1")
    expect(reduce(s, { type: "own-order-seen", label: "bobby1", url: "/?order=inv-1" })).toBe(s)
    expect(reduce(open(), { type: "own-order-seen", label: "alice1", url: "/?order=inv-1" }).ownOrder).toBeNull()
  })
})

describe("reduce: retargets", () => {
  it("retarget-read takes the order as the service has it", () => {
    const s = open({ opening: "retarget", retarget: record() })
    expect(reduce(s, { type: "retarget-read", record: record({ paid: 2500 }), moved: null }).retarget).toEqual(record({ paid: 2500 }))
  })
  it("retarget-read for an order gone elsewhere says where, and the search is a plain one", () => {
    const s = run(open({ opening: "retarget", retarget: record() }), { type: "register-started" })
    const moved = { to: "name" as const, url: "/?order=inv-1", label: "other1", tld: "simplex" }
    expect(reduce(s, { type: "retarget-read", record: record(), moved })).toMatchObject({ retarget: null, moved, register: { busy: false, refusal: null } })
  })
  it("retarget-read for another order, or on a page with none, changes nothing", () => {
    const s = open({ opening: "retarget", retarget: record() })
    expect(reduce(s, { type: "retarget-read", record: record({ registrationId: "reg-2" }), moved: null })).toBe(s)
    const plain = open()
    expect(reduce(plain, { type: "retarget-read", record: record(), moved: null })).toBe(plain)
  })
})

describe("reduce: register", () => {
  it("register-started works, and a refusal ends it", () => {
    const s = reduce(shown(), { type: "register-started" })
    expect(s.register).toEqual({ busy: true, refusal: null })
    expect(reduce(s, { type: "register-refused", refusal: { why: "other", invoiceId: "inv-9" } }).register).toEqual({ busy: false, refusal: { why: "other", invoiceId: "inv-9" } })
  })
  it("register-held holds the tab, saying nothing changed, and keeps the answer shown", () => {
    const s = reduce(shown(), { type: "register-started" })
    expect(reduce(s, { type: "register-held", until: NOW + 5000 })).toMatchObject({ register: { busy: false, refusal: null }, hold: { until: NOW + 5000, lead: REGISTER_LEAD }, paused: false, answer: s.answer })
  })
})

describe("returnedTo", () => {
  it("a search gone back to for the same name shows its last answer again, with nothing searched again", () => {
    const s = shown("alice1", TAKEN)
    const back = returnedTo(s, "plain", "alice1")
    expect(back).toEqual(s)
    expect(searchDue(reduce(back, openedEvent({ name: "alice1" })))).toBe(false)
    expect(reduce(back, openedEvent({ name: "alice1" })).answer).toEqual(s.answer)
  })
  it("what was under way on the page left ended with it: a search, and a register at work", () => {
    const s = shown()
    const left = { ...reduce(reduce(s, { type: "register-started" }), searchedEvent("bobby1")), name: "alice1" }
    expect(left.searching).not.toBeNull()
    expect(returnedTo(left, "plain", "alice1")).toEqual({ ...left, searching: null, register: { busy: false, refusal: null } })
  })
  it("starts anew for another name, another way of opening, or a page that showed no answer", () => {
    const s = shown()
    expect(returnedTo(s, "plain", "bobby1")).toEqual(initialSearch())
    expect(returnedTo(s, "fromApp", "alice1")).toEqual(initialSearch())
    expect(returnedTo(open({ name: "alice1" }), "plain", "alice1")).toEqual(initialSearch())
    const ruled = reduce(open({ name: "abc" }), searchedEvent("abc"))
    expect(returnedTo(ruled, "plain", "abc")).toEqual(initialSearch())
  })
  it("a wait met elsewhere in the tab still pauses a search gone back to", () => {
    const back = returnedTo(shown(), "plain", "alice1")
    expect(reduce(back, openedEvent({ name: "alice1", hold: wait(NOW + 5000) }))).toMatchObject({ paused: true, answer: null })
  })
  it("a search gone back to whose check again fails no longer shows its remembered answer", () => {
    const back = reduce(returnedTo(shown(), "plain", "alice1"), openedEvent({ name: "alice1" }))
    expect(back.answer).toMatchObject({ kind: "found", answer: AVAILABLE })
    expect(reduce(back, { type: "unanswered", seq: back.seq })).toMatchObject({ answer: { kind: "unchecked" }, paused: false })
    expect(reduce(back, { type: "search-held", seq: back.seq, until: NOW + 10_000 })).toMatchObject({ answer: null, paused: true, hold: { until: NOW + 10_000, lead: NO_LEAD } })
  })
})
