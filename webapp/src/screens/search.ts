import type { SearchAnswer } from "../api.ts"
import { foldLabel, type LabelProblem, labelProblem } from "../names.ts"
import type { OrderRecord } from "../store.ts"
import { type Hold, NO_LEAD } from "./hold.ts"

export type Opening = "fromApp" | "retarget" | "plain" | "bad-app-link"
export type SearchKind = `search:${Exclude<Opening, "bad-app-link">}` | "status:bad-app-link"

export interface Mine { registrationId: string; withCode: boolean }
export type Answer =
  | { kind: "rule"; label: string; problem: LabelProblem }
  | { kind: "found"; label: string; answer: SearchAnswer; mine: Mine | null; now: number }
  | { kind: "unchecked" }
  | { kind: "checking" }

export type Moved = { to: "code"; url: string } | { to: "name"; url: string; label: string; tld: string }
type RegisterRefusal = { why: "taken" | "failed" } | { why: "other"; invoiceId: string }

export interface SearchState {
  opening: Opening
  name: string
  typed: string
  searched: string | null
  seq: number
  searching: { label: string } | null
  answer: Answer | null
  bad: boolean
  fromApp: string | null
  retarget: OrderRecord | null
  moved: Moved | null
  hold: Hold | null
  paused: boolean
  ownOrder: string | null
  register: { busy: boolean; refusal: RegisterRefusal | null }
}

export type SearchEvent =
  | { type: "opened"; opening: Opening; name: string; fromApp: string | null; retarget: OrderRecord | null; hold: Hold | null }
  | { type: "typed"; text: string }
  | { type: "searched"; label: string; hold: Hold | null }
  | { type: "answered"; seq: number; label: string; answer: SearchAnswer; mine: Mine | null; now: number }
  | { type: "unanswered"; seq: number }
  | { type: "search-held"; seq: number; until: number }
  | { type: "hold-ended" }
  | { type: "own-order-seen"; label: string; url: string | null }
  | { type: "retarget-read"; record: OrderRecord; moved: Moved | null }
  | { type: "register-started" }
  | { type: "register-refused"; refusal: RegisterRefusal }
  | { type: "register-held"; until: number }

const IDLE = { busy: false, refusal: null }
export const REGISTER_LEAD = "Nothing changed. "

export const initialSearch = (): SearchState => ({
  opening: "plain", name: "", typed: "", searched: null, seq: 0, searching: null, answer: null, bad: false, fromApp: null,
  retarget: null, moved: null, hold: null, paused: false, ownOrder: null, register: IDLE,
})

// An available name this browser has ordered since may be taken now, by its own order too, so it is checked again first.
export function returnedTo(s: SearchState, opening: Opening, name: string, ordered: boolean): SearchState {
  if (s.opening !== opening || s.name !== name || s.answer?.kind !== "found") return initialSearch()
  return { ...s, searching: null, register: IDLE, answer: ordered && s.answer.answer.status === "available" ? { kind: "checking" } : s.answer }
}

const unsearched = (s: SearchState) => foldLabel(s.typed) !== s.name

export const searchDue = (s: SearchState): boolean => !s.paused && s.name !== "" && s.name !== s.searched && !unsearched(s)

function opened(s: SearchState, e: Extract<SearchEvent, { type: "opened" }>): SearchState {
  const typed = e.name === s.name ? s.typed : e.name
  const next = { ...s, opening: e.opening, name: e.name, typed, fromApp: e.fromApp, register: { ...s.register, refusal: null } }
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

export function reduce(s: SearchState, e: SearchEvent): SearchState {
  switch (e.type) {
    case "opened": return opened(s, e)
    case "typed": return { ...s, typed: e.text, bad: false }
    case "searched": return searched(s, e)
    case "answered": {
      if (e.seq !== s.seq) return s
      const same = s.answer?.kind === "found" && s.answer.label === e.label
      return { ...s, searching: null, answer: { kind: "found", label: e.label, answer: e.answer, mine: e.mine, now: e.now }, ownOrder: same ? s.ownOrder : null }
    }
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
  }
}

export function screenOf(s: SearchState): SearchKind {
  return s.opening === "bad-app-link" ? "status:bad-app-link" : `search:${s.opening}`
}
