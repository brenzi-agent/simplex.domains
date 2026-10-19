import { holdsPayment, type CodeState, type InvoiceView, type Links, type Phase, type RegistrationView, type SearchAnswer } from "../api.ts"
import { dateOf } from "../format.ts"
import { type CodeRecord, type OrderRecord, orderUrl, type PendingCode } from "../store.ts"
import { type Hold, NO_LEAD } from "./hold.ts"

export interface RowSeen { view: RegistrationView; invoice: InvoiceView | null; answer?: SearchAnswer | null; linksSavedAt?: string }
export type CodeCheck = CodeState | "unchecked"
export type Finding = "finding" | "none" | "unchecked"

export interface Stored { orders: OrderRecord[]; pending: PendingCode[]; codes: CodeRecord[]; canPersist: boolean }

export interface ListState extends Stored {
  hold: Hold | null
  now: number
  seen: Record<string, RowSeen>
  unread: string[]
  checked: Record<string, CodeCheck>
  finding: Record<string, Finding>
  asking: boolean
  // the registered row expanded with its name code
  shownCode: string | null
}

export type ListEvent =
  | ({ type: "stored"; hold: Hold | null } & Stored)
  | { type: "row-read"; id: string; view: RegistrationView; invoice: InvoiceView | null; now: number }
  | { type: "row-answered"; id: string; answer: SearchAnswer | null; linksSavedAt: string | undefined }
  | { type: "row-unread"; id: string }
  | { type: "code-toggled"; id: string }
  | { type: "code-read"; code: string; state: CodeCheck }
  | { type: "find-started"; ownerCode: string }
  | { type: "find-ended"; ownerCode: string; outcome: "none" | "unchecked" }
  | { type: "find-held"; ownerCode: string; until: number }
  | { type: "hold-ended" }
  | { type: "forget-asked" }
  | { type: "forget-kept" }
  | { type: "forget-confirmed" }

const keep = <T>(map: Record<string, T>, keys: string[]): Record<string, T> => Object.fromEntries(keys.filter((k) => k in map).map((k) => [k, map[k]]))
const idsOf = (s: Stored) => s.orders.map((o) => o.registrationId)

export function initialList(stored: Stored, hold: Hold | null, seen: Record<string, RowSeen>, checked: Record<string, CodeCheck>, now: number): ListState {
  const known = stored.codes.map((c) => c.code).filter((c) => checked[c] !== "unchecked")
  const unreplaced = stored.orders.filter((o) => !o.replacedBy).map((o) => o.registrationId)
  return { ...stored, hold, now, seen: linksCurrent(keep(seen, unreplaced), stored.orders), unread: [], checked: keep(checked, known), finding: {}, asking: false, shownCode: null }
}

export const hasRecords = (s: Stored) => s.orders.length > 0 || s.pending.length > 0 || s.codes.length > 0

export function reduceList(s: ListState, e: ListEvent): ListState {
  const ordered = (id: string) => s.orders.some((o) => o.registrationId === id)
  const pendingFor = (ownerCode: string) => s.pending.some((p) => p.ownerCode === ownerCode)
  switch (e.type) {
    case "stored": {
      const { type: _, ...stored } = e
      const unreplaced = new Set(s.orders.filter((o) => !o.replacedBy).map((o) => o.registrationId))
      const ids = idsOf(stored).filter((id) => !(unreplaced.has(id) && stored.orders.find((o) => o.registrationId === id)?.replacedBy))
      return { ...s, ...stored, seen: linksCurrent(keep(s.seen, ids), stored.orders), unread: s.unread.filter((id) => ids.includes(id)),
        checked: keep(s.checked, stored.codes.map((c) => c.code)), finding: keep(s.finding, stored.pending.map((p) => p.ownerCode)), asking: s.asking && hasRecords(stored),
        shownCode: s.shownCode !== null && ids.includes(s.shownCode) ? s.shownCode : null }
    }
    case "row-read": {
      const o = s.orders.find((r) => r.registrationId === e.id)
      if (!o || (o.replacedBy && !moneyReached(e.invoice))) return s
      const last = s.seen[e.id]
      const kept = last?.view.phase === "registered" && e.view.phase === "registered" ? { answer: last.answer, linksSavedAt: last.linksSavedAt } : {}
      return { ...s, now: e.now, seen: { ...s.seen, [e.id]: { view: e.view, invoice: e.invoice, ...kept } }, unread: s.unread.filter((id) => id !== e.id) }
    }
    // An answer asked for before the name's last save is dropped: the save changed the record, which is read again.
    case "row-answered": {
      const current = e.linksSavedAt === s.orders.find((o) => o.registrationId === e.id)?.linksSavedAt
      return s.seen[e.id] && current ? { ...s, seen: { ...s.seen, [e.id]: { ...s.seen[e.id], answer: e.answer, linksSavedAt: e.linksSavedAt } } } : s
    }
    case "row-unread": return ordered(e.id) && !s.unread.includes(e.id) ? { ...s, unread: [...s.unread, e.id] } : s
    case "code-toggled": return { ...s, shownCode: s.shownCode === e.id ? null : ordered(e.id) ? e.id : s.shownCode }
    case "code-read": return s.codes.some((c) => c.code === e.code) ? { ...s, checked: { ...s.checked, [e.code]: e.state } } : s
    case "find-started": return pendingFor(e.ownerCode) ? { ...s, finding: { ...s.finding, [e.ownerCode]: "finding" } } : s
    case "find-ended": return pendingFor(e.ownerCode) ? { ...s, finding: { ...s.finding, [e.ownerCode]: e.outcome } } : s
    case "find-held": {
      const { [e.ownerCode]: _, ...finding } = s.finding
      return { ...s, finding, hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: NO_LEAD } }
    }
    case "hold-ended": return { ...s, hold: null }
    case "forget-asked": return hasRecords(s) ? { ...s, asking: true } : s
    case "forget-kept": return { ...s, asking: false }
    case "forget-confirmed": return { ...s, orders: [], pending: [], codes: [], seen: {}, unread: [], checked: {}, finding: {}, asking: false, shownCode: null }
  }
}

export const moneyReached = (invoice: InvoiceView | null) => invoice !== null && (invoice.status === "paid" || holdsPayment(invoice))

export function listedOrders(s: ListState): OrderRecord[] {
  const shown = (o: OrderRecord) => !o.replacedBy || (s.seen[o.registrationId] !== undefined && moneyReached(s.seen[o.registrationId].invoice))
  const index = new Map(s.orders.map((o, i) => [o.registrationId, i]))
  const byUrl = new Map(s.orders.map((o) => [orderUrl(o), o]))
  const predecessor = new Map<string, OrderRecord>()
  for (const o of s.orders) {
    const next = !shown(o) && o.replacedBy ? byUrl.get(o.replacedBy) : undefined
    if (next && !predecessor.has(next.registrationId)) predecessor.set(next.registrationId, o)
  }
  const slotOf = (o: OrderRecord, passed = new Set<string>()): number => {
    const before = predecessor.get(o.registrationId)
    if (!before || passed.has(before.registrationId)) return index.get(o.registrationId)!
    passed.add(o.registrationId)
    return slotOf(before, passed)
  }
  return s.orders.filter(shown).map((o) => ({ o, slot: slotOf(o), at: index.get(o.registrationId)! }))
    .sort((a, b) => a.slot - b.slot || a.at - b.at).map(({ o }) => o)
}

// A registered name past its expiry: there are no renewals, so the page takes it as over, though the chain keeps it its
// holder's through the grace period, and whether or not someone has registered it again since.
export const lapsed = ({ view, answer }: Pick<RowSeen, "view" | "answer">, now: number) =>
  view.phase === "registered" && ((view.expiresAt !== null && view.expiresAt < now / 1000) || answer?.status === "available")

// A row's links read before its name's last save, from this tab or another, are not shown as current.
function linksCurrent(seen: Record<string, RowSeen>, orders: OrderRecord[]): Record<string, RowSeen> {
  const stale = orders.filter((o) => seen[o.registrationId]?.answer && seen[o.registrationId].linksSavedAt !== o.linksSavedAt)
  return stale.length ? { ...seen, ...Object.fromEntries(stale.map((o) => [o.registrationId, { ...seen[o.registrationId], answer: null }])) } : seen
}

export const waitsToSign = (view: RegistrationView, now: number) =>
  view.phase === "committed" && view.label === null && view.revealAfter !== null && now / 1000 >= view.revealAfter

const PHASE_CHIPS: Record<Phase, [string, string]> = {
  unpaid: ["Waiting for payment", "warn"],
  queued: ["Registering", "brand"], committing: ["Registering", "brand"], committed: ["Registering", "brand"], registering: ["Registering", "brand"],
  registered: ["Registered", "ok"], taken: ["Taken first", "warn"], failed: ["Not registered", "bad"], code_issued: ["Code taken", "ok"],
}

export function phaseChip(view: RegistrationView, invoice: InvoiceView | null, o: OrderRecord, now: number): [string, string] {
  if (waitsToSign(view, now) && o.ownerCode !== null) return ["Open to finish", "warn"]
  if (view.phase !== "unpaid") return PHASE_CHIPS[view.phase]
  if (invoice?.status === "expired") return o.cancelled && !holdsPayment(invoice) ? ["Invoice cancelled", "bad"] : ["Invoice expired", holdsPayment(invoice) ? "warn" : "bad"]
  if (o.cancelled && invoice?.status === "open" && !invoice.paidInFull) return ["Invoice cancelled", "warn"]
  if (invoice?.status === "paid") return ["Paid late", "warn"]
  if (invoice?.paidInFull || o.cardSubmittedAt) return ["Confirming payment", "warn"]
  if (invoice?.amountPaid || Number(invoice?.cryptoAmountPaid ?? "0") > 0) return ["Waiting for the rest", "warn"]
  return PHASE_CHIPS.unpaid
}

export const CODE_CHIPS: Record<CodeState, [string, string]> = {
  unused: ["Unused", "ok"], used: ["Used", "bad"], reserved: ["In use", "brand"],
  expired: ["Expired", "bad"], unpaid: ["Not paid yet", "warn"], revoked: ["Not valid", "bad"],
}

export function editable(answer: SearchAnswer, owner: string): boolean {
  if (answer.status !== "registered" || answer.owner === undefined) return true
  return answer.owner.toLowerCase() === owner.toLowerCase() && answer.records !== null
}

type RefusalKind = "invalid" | "prepaid" | "none" | "unasked" | "other"
export interface Refusal { verdict: boolean; title: string; text: string; again: boolean }
export const REFUSALS: Record<RefusalKind, Refusal> = {
  invalid: { verdict: true, title: "This code is not valid", text: "Check it for a mistyped character.", again: false },
  prepaid: { verdict: true, title: "This is a prepaid code", text: "It pays for a name rather than owning one. Add it under Your names, or use it at checkout.", again: false },
  none: { verdict: false, title: "No order was found for this code", text: "The service has no order registered to its wallet.", again: false },
  unasked: { verdict: false, title: "The service could not be asked now", text: "Your code is fine to try again in a moment.", again: true },
  other: { verdict: false, title: "This code does not open the order", text: "The order found for it was made with another code.", again: false },
}

export interface RestoreState { busy: boolean; refusal: RefusalKind | null; hold: Hold | null }
export type RestoreEvent = { type: "opened" } | { type: "edited" } | { type: "refused"; why: RefusalKind } | { type: "find-started" } | ({ type: "held" } & Hold) | { type: "hold-ended" }

export const initialRestore = (hold: Hold | null): RestoreState => ({ busy: false, refusal: null, hold })

export function reduceRestore(s: RestoreState, e: RestoreEvent): RestoreState {
  switch (e.type) {
    case "opened": return s
    case "edited": return s.hold ? s : { ...s, refusal: null }
    case "refused": return { ...s, busy: false, refusal: e.why }
    case "find-started": return { ...s, busy: true, refusal: null }
    case "held": return { ...s, busy: false, refusal: null, hold: { until: e.until, lead: e.lead } }
    case "hold-ended": return { ...s, hold: null }
  }
}

export const EDIT_RETRY_MS = 5000
export type EditKind = "edit" | "edit-unreadable" | "edit-no-code" | "edit-expired" | "edit-in-app" | "edit-elsewhere" | "edit-not-registered"
export interface EditRead { view: RegistrationView; answer: SearchAnswer; now: number }
type EditResult = "sending" | "nothing" | "saved" | "unanswered" | "moved" | "refused"

export interface EditForm {
  current: Links
  values: Links
  nonce: number
  changes: Partial<Links>
  sent: (keyof Links)[]
  saving: boolean
  unanswered: boolean
  settled: boolean
  result: EditResult | null
  hold: Hold | null
}

export interface EditState {
  registrationId: string
  record: OrderRecord | null
  read: EditRead | null
  form: EditForm | null
  failures: number
  reading: boolean
}

export type EditEvent =
  | { type: "opened" }
  | { type: "answered"; view: RegistrationView; answer: SearchAnswer; record: OrderRecord; now: number; hold: Hold | null }
  | { type: "read-failed" }
  | { type: "read-started" }
  | { type: "field-changed"; kind: keyof Links; value: string }
  | { type: "save-started" }
  | { type: "link-saved"; kind: keyof Links }
  | { type: "save-done" }
  | { type: "save-unanswered" }
  | { type: "save-held"; until: number }
  | { type: "save-refused"; moved: { nonce: number; records: Links | null } | null }
  | { type: "hold-ended" }

export const initialEdit = (registrationId: string, record: OrderRecord | null): EditState => ({ registrationId, record, read: null, form: null, failures: 0, reading: false })

export const LINK_NAMES: Record<keyof Links, string> = { contact: "address", channel: "channel" }
const LINK_KINDS = ["contact", "channel"] as const

export const changesOf = (f: EditForm): Partial<Links> => Object.fromEntries(LINK_KINDS.filter((k) => f.values[k] !== f.current[k]).map((k) => [k, f.values[k]]))

// the contract's GRACE_PERIOD: an expired name stays its holder's this long before anyone can register it again
export const GRACE_S = 90 * 86_400
type Again = { when: "now" } | { when: "from"; at: number } | { when: "taken" }
export function registrableAgain(expiresAt: number | null, answer: SearchAnswer, now: number): Again {
  if (answer.status === "available") return { when: "now" }
  if (expiresAt !== null && now / 1000 < expiresAt + GRACE_S) return { when: "from", at: expiresAt + GRACE_S }
  return { when: "taken" }
}

export const ranOut = (expiresAt: number | null) => `Its registration ran out${expiresAt ? ` on ${dateOf(expiresAt)}` : ""}.`

export function againLine(expiresAt: number | null, answer: SearchAnswer, now: number): string {
  const again = registrableAgain(expiresAt, answer, now)
  if (again.when === "now") return "Search it to register it again."
  return again.when === "from" ? `It can be registered again from ${dateOf(again.at)}.` : "It has been registered again since."
}

export const unsent = (changes: Partial<Links>, sent: (keyof Links)[]) => (Object.keys(changes) as (keyof Links)[]).find((k) => !sent.includes(k))

// an edit sends each link on its own, so one can be on chain when the next fails
export function notSaved({ changes, sent }: EditForm): string {
  const rest = unsent(changes, sent)
  return sent.length && rest ? `The ${LINK_NAMES[sent[0]]} was saved; the ${LINK_NAMES[rest]} was not.` : "The links were not saved."
}

const owns = (answer: SearchAnswer, owner: string) => answer.status === "registered" && answer.owner !== undefined && answer.owner.toLowerCase() === owner.toLowerCase()

export function screenOfEdit(s: EditState): EditKind {
  if (!s.record?.ownerCode) return "edit-no-code"
  if (!s.read) return "edit-unreadable"
  const { view, answer, now } = s.read
  if (lapsed({ view, answer }, now)) return "edit-expired"
  if (answer.status === "registered" && answer.owner !== undefined && !owns(answer, s.record.owner)) return "edit-in-app"
  if (answer.status === "registered" && owns(answer, s.record.owner) && answer.records === null) return "edit-elsewhere"
  if (view.phase !== "registered" || answer.status !== "registered" || !answer.records || answer.recordsNonce == null) return "edit-not-registered"
  return "edit"
}

function formOf(answer: SearchAnswer, hold: Hold | null): EditForm | null {
  if (answer.status !== "registered" || !answer.records || answer.recordsNonce == null) return null
  return { current: { ...answer.records }, values: { ...answer.records }, nonce: answer.recordsNonce, changes: {}, sent: [],
    saving: false, unanswered: false, settled: false, result: null, hold }
}

function applyToForm(f: EditForm, e: EditEvent): EditForm {
  switch (e.type) {
    case "field-changed": {
      if (f.values[e.kind] === e.value) return f
      const values = { ...f.values, [e.kind]: e.value }
      if (f.saving || f.unanswered || f.hold) return { ...f, values }
      return { ...f, values, settled: false, result: e.value === f.current[e.kind] ? f.result : null }
    }
    case "save-started": {
      const changes = changesOf(f)
      if (Object.keys(changes).length === 0) return { ...f, result: "nothing" }
      return { ...f, changes, sent: [], saving: true, result: "sending" }
    }
    case "link-saved": return { ...f, nonce: f.nonce + 1, sent: [...f.sent, e.kind], current: { ...f.current, [e.kind]: f.changes[e.kind] ?? f.current[e.kind] } }
    case "save-done": return { ...f, saving: false, result: "saved", settled: Object.keys(changesOf(f)).length === 0 }
    case "save-unanswered": return { ...f, saving: false, unanswered: true, result: "unanswered" }
    case "save-held": return { ...f, saving: false, result: null, hold: { until: e.until, lead: `${notSaved(f)} ` } }
    case "save-refused": {
      if (!e.moved) return { ...f, saving: false, result: "refused" }
      return { ...f, saving: false, result: "moved", nonce: e.moved.nonce, current: e.moved.records ? { ...e.moved.records } : f.current }
    }
    case "hold-ended": return { ...f, hold: null }
    default: return f
  }
}

export function reduceEdit(s: EditState, e: EditEvent): EditState {
  switch (e.type) {
    case "answered": {
      const next = { ...s, record: e.record, read: { view: e.view, answer: e.answer, now: e.now }, reading: false }
      return { ...next, form: s.form ?? (screenOfEdit(next) === "edit" ? formOf(e.answer, e.hold) : null) }
    }
    case "opened": return s
    case "read-failed": return { ...s, failures: s.failures + 1, reading: false }
    case "read-started": return { ...s, reading: true }
    default: {
      if (!s.form) return s
      const form = applyToForm(s.form, e)
      return form === s.form ? s : { ...s, form }
    }
  }
}
