import { type Community, currentTerms, type SearchAnswer, type Terms } from "../api.ts"
import { parseNameCode } from "../crypto/code.ts"
import { dollars } from "../format.ts"
import { heldWords } from "./balance.ts"
import { foldLabel, type LabelProblem, labelProblem } from "../names.ts"
import type { AppliedBalance } from "../session.ts"
import type { OrderRecord } from "../store.ts"
import { type Hold, NO_LEAD } from "./hold.ts"

export type Opening = "retarget" | "plain"
export type SearchKind = `search:${Opening}`

export type Answer =
  | { kind: "rule"; label: string; problem: LabelProblem }
  | { kind: "found"; label: string; answer: SearchAnswer; mine: boolean; now: number }
  | { kind: "unchecked" }
  | { kind: "checking" }

export type Moved = { url: string; label: string; tld: string }
type RegisterRefusal = { why: "taken" | "failed" | "dearer" | "uncovered" } | { why: "other"; url: string } | { why: "limit"; reference: string }

export interface SearchState {
  opening: Opening
  name: string
  typed: string
  searched: string | null
  seq: number
  searching: { label: string } | null
  answer: Answer | null
  bad: boolean
  retarget: OrderRecord | null
  // the tab's balance, which pays for a name searched here unless a paid order moves
  balance: AppliedBalance | null
  moved: Moved | null
  hold: Hold | null
  paused: boolean
  ownOrder: string | null
  register: { busy: boolean; refusal: RegisterRefusal | null }
  agreed: boolean
  termsChanged: boolean
}

export type SearchEvent =
  | { type: "opened"; opening: Opening; name: string; retarget: OrderRecord | null; balance: AppliedBalance | null; hold: Hold | null }
  | { type: "balance-read"; balance: AppliedBalance | null }
  | { type: "typed"; text: string }
  | { type: "searched"; label: string; hold: Hold | null }
  | { type: "answered"; seq: number; label: string; answer: SearchAnswer; mine: boolean; now: number }
  | { type: "unanswered"; seq: number }
  | { type: "search-held"; seq: number; until: number }
  | { type: "hold-ended" }
  | { type: "own-order-seen"; label: string; url: string | null }
  | { type: "retarget-read"; record: OrderRecord; moved: Moved | null }
  | { type: "register-started" }
  | { type: "register-refused"; refusal: RegisterRefusal }
  | { type: "register-held"; until: number }
  | { type: "agreed"; agreed: boolean }
  | { type: "terms-changed"; label: string; terms: Terms; community: Community | null }

const IDLE = { busy: false, refusal: null }
export const REGISTER_LEAD = "Nothing changed. "

export const initialSearch = (): SearchState => ({
  opening: "plain", name: "", typed: "", searched: null, seq: 0, searching: null, answer: null, bad: false,
  retarget: null, balance: null, moved: null, hold: null, paused: false, ownOrder: null, register: IDLE, agreed: false, termsChanged: false,
})

// An available name this browser has an order for, under its TLD, is checked again rather than offered while the order is read.
export function returnedTo(s: SearchState, opening: Opening, name: string, orders: Pick<OrderRecord, "label" | "tld">[]): SearchState {
  if (s.opening !== opening || s.name !== name || s.answer?.kind !== "found") return initialSearch()
  const found = s.answer.answer
  const ordered = found.status === "available" && orders.some((o) => o.label === name && o.tld === found.tld)
  return { ...s, searching: null, register: IDLE, answer: ordered ? { kind: "checking" } : s.answer }
}

const unsearched = (s: SearchState) => foldLabel(s.typed) !== s.name

export const searchDue = (s: SearchState): boolean => !s.paused && s.name !== "" && s.name !== s.searched && !unsearched(s)

function opened(s: SearchState, e: Extract<SearchEvent, { type: "opened" }>): SearchState {
  const typed = e.name === s.name ? s.typed : e.name
  const next = { ...s, opening: e.opening, name: e.name, typed, balance: e.balance, register: { ...s.register, refusal: null } }
  next.retarget = s.moved ? null : e.retarget
  const dropped = unsearched(next) ? { answer: null, searching: null, bad: false, seq: s.seq + 1 } : {}
  if (s.hold || e.hold === null) return { ...next, ...dropped }
  return { ...next, answer: null, searching: null, bad: false, seq: s.seq + 1, hold: e.hold, paused: true }
}

function searched(s: SearchState, e: Extract<SearchEvent, { type: "searched" }>): SearchState {
  if (s.paused || !e.label) return s
  const seq = s.seq + 1
  if (e.hold !== null) return { ...s, seq, answer: null, searching: null, bad: false, hold: { ...e.hold, until: Math.max(e.hold.until, s.hold?.until ?? 0) }, paused: true }
  // the field shows the name searched, as ".simplex" typed after it is already shown beside the field
  const started = { ...s, seq, name: e.label, searched: e.label, typed: e.label, register: IDLE }
  const problem = labelProblem(e.label)
  if (problem) return { ...started, searching: null, answer: { kind: "rule", label: e.label, problem }, bad: true }
  return { ...started, searching: { label: e.label } }
}

const termsOf = (a: SearchAnswer) => a.status === "available" ? currentTerms(a) : null

function answered(s: SearchState, e: Extract<SearchEvent, { type: "answered" }>): SearchState {
  if (e.seq !== s.seq) return s
  const before = s.answer?.kind === "found" && s.answer.label === e.label ? s.answer : null
  const same = before !== null
  const agreed = same && s.agreed && termsOf(before.answer) === termsOf(e.answer)
  return { ...s, searching: null, answer: { kind: "found", label: e.label, answer: e.answer, mine: e.mine, now: e.now }, ownOrder: same ? s.ownOrder : null, agreed, termsChanged: same && s.termsChanged }
}

function termsChanged(s: SearchState, e: Extract<SearchEvent, { type: "terms-changed" }>): SearchState {
  if (s.answer?.kind !== "found" || s.answer.label !== e.label || s.answer.answer.status !== "available") return s
  const answer = { ...s.answer, answer: { ...s.answer.answer, terms: e.terms, community: e.community } }
  return { ...s, answer, agreed: false, termsChanged: true, register: IDLE }
}

export function reduce(s: SearchState, e: SearchEvent): SearchState {
  switch (e.type) {
    case "opened": return opened(s, e)
    case "balance-read": return { ...s, balance: e.balance }
    case "typed": return { ...s, typed: e.text, bad: false }
    case "searched": return searched(s, e)
    case "answered": return answered(s, e)
    case "unanswered": return e.seq === s.seq ? { ...s, searching: null, answer: { kind: "unchecked" } } : s
    case "search-held": return e.seq === s.seq ? { ...s, searching: null, answer: null, hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: NO_LEAD }, paused: true } : s
    case "hold-ended": return { ...s, hold: null, paused: false, answer: s.paused && foldLabel(s.typed) ? { kind: "checking" } : s.answer }
    case "own-order-seen": return s.answer?.kind === "found" && s.answer.label === e.label ? { ...s, ownOrder: e.url } : s
    case "retarget-read":
      if (s.retarget?.registrationId !== e.record.registrationId) return s
      return e.moved ? { ...s, retarget: null, moved: e.moved, register: IDLE } : { ...s, retarget: e.record, register: IDLE }
    case "register-started": return { ...s, register: { busy: true, refusal: null } }
    case "register-refused": return { ...s, register: { busy: false, refusal: e.refusal } }
    case "register-held": return { ...s, register: IDLE, hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: REGISTER_LEAD } }
    case "agreed": return { ...s, agreed: e.agreed, termsChanged: e.agreed ? false : s.termsChanged }
    case "terms-changed": return termsChanged(s, e)
  }
}

export function screenOf(s: SearchState): SearchKind {
  return `search:${s.opening}`
}

// What the tab's balance pays of an available name's price, in two sentences, the second kept on one line; a balance an
// open invoice holds pays nothing until that invoice closes.
export function balanceHint({ amount, held, heldUntil }: AppliedBalance, price: number): [string, string | null] {
  if (held) return [`Your balance is in use by another order ${heldWords(heldUntil)}.`, null]
  if (price > amount) return [`Your balance covers ${dollars(amount)}.`, `You pay ${dollars(price - amount)}.`]
  return ["Paid from your balance.", price < amount ? `${dollars(amount - price)} stays in it.` : null]
}

export interface CodeCover { minLength: number; years: number }

// What a code order's code pays for: a name of the code's length or more, for the order's years. A browser that restored
// the order has not got its code, which pays at least for the order's own name. An order paid with money has none.
export function codeCover(record: OrderRecord): CodeCover | null {
  if (record.method !== "code") return null
  const code = record.prepaidCode ? parseNameCode(record.prepaidCode) : null
  return { minLength: code?.kind === "prepaid" ? code.minLength : record.label.length, years: record.years }
}

// Why an order cannot move to an available name: its code does not pay for one so short, or the name costs more than
// the order is worth.
export function moveBar(record: OrderRecord, label: string, price: number): "uncovered" | "dearer" | null {
  const cover = codeCover(record)
  if (cover) return label.length < cover.minLength ? "uncovered" : null
  return price > record.paid ? "dearer" : null
}

// What pays for an available name an order moves to, in one or two sentences, the second kept on one line; a cheaper
// name keeps the rest as the order's balance, which is said before the buyer chooses it.
export function moveHint(record: OrderRecord, label: string, price: number): [string, string | null] {
  const cover = codeCover(record)
  if (cover) return label.length < cover.minLength ? [`Your code pays for a name of ${cover.minLength} or more letters.`, `This name has ${label.length}.`] : ["Covered by your code", null]
  const paid = dollars(record.paid)
  if (price > record.paid) return [`This name costs more than the ${paid} your order is worth.`, null]
  return [price < record.paid ? `Uses ${dollars(price)} of your ${paid}; the rest stays as your balance.` : "Covered by your payment", null]
}

// what a moving order keeps, and which names it can move to
export function keptWords(record: OrderRecord): [string, string] {
  const cover = codeCover(record)
  if (cover) return ["Your code is kept.", `It pays for another name of ${cover.minLength} or more letters, for ${cover.years} years.`]
  const worth = dollars(record.paid)
  return [`Your payment is kept: ${worth}.`, `Choose another name of up to ${worth}; nothing more is charged.`]
}
