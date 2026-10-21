import { holdsPayment, type InvoiceView, type RegistrationView } from "../api.ts"
import type { IconName } from "../icons.ts"
import type { CodeRefusal, OrderRecord } from "../store.ts"
import { type Hold, NO_LEAD } from "./hold.ts"

// a card payment Stripe has not confirmed after this long gets the "not confirmed" page
export const CARD_SLOW_MS = 10 * 60 * 1000
// refusals of the signed registration after which the page stops signing and says so
export const REVEAL_ATTEMPTS = 3

export type OrderKind = "pay-crypto" | "pay-card" | "confirming" | "registering" | "registered" | "taken" | "code-issued" | "failed" | "not-on-device"
  | "status:closed" | "status:card-unconfirmed" | "status:paid-by-invoice" | "status:unreadable" | "status:unknown-link" | "status:price-changed"

export type ClosedCase = "paid-late" | "still-open" | "cancelled" | "received" | "expired"

type Action = "card" | "cancel" | "reorder" | "code" | "retry"

export interface Note { tone: "warn" | "danger"; icon: IconName; title: string | null; text: string; link?: { text: string; href: string; after: string } }

interface Reveal { key: string; sending: boolean; refusals: number }

export interface OrderState {
  reference: string
  seq: number
  now: number
  invoice: InvoiceView | null
  view: RegistrationView | null
  record: OrderRecord | null
  cardSubmittedAt: string | null
  cardFailed: boolean
  reveal: Reveal | null
  busy: Action | null
  note: Note | null
  hold: Hold | null
  price: number | null
  gone: boolean
  codeRefused: boolean
  // the service said the order's code is unspent, which the failed page waits for before saying so
  codeKept: boolean
}

export type OrderEvent =
  | { type: "answered"; seq: number; now: number; invoice: InvoiceView | null; view: RegistrationView; record: OrderRecord | null; cardSubmittedAt: string | null }
  | { type: "record-changed"; record: OrderRecord | null; cardSubmittedAt: string | null }
  | { type: "read-failed" }
  | { type: "not-found" }
  | { type: "tick"; now: number }
  | { type: "card-started" }
  | { type: "card-submitted"; at: string }
  | { type: "card-failed" }
  | { type: "card-refused"; note: Note | null }
  | { type: "reveal-sent"; key: string }
  | { type: "reveal-refused"; key: string }
  | { type: "reveal-failed"; key: string }
  | { type: "reveal-retried" }
  | { type: "cancel-started" }
  | { type: "cancel-answered"; note: Note | null }
  | { type: "cancel-failed"; note: Note }
  | { type: "reorder-started" }
  | { type: "reorder-failed"; note: Note }
  | { type: "price-changed"; price: number }
  | { type: "code-started" }
  | { type: "code-failed"; note: Note }
  | { type: "retry-started" }
  | { type: "retry-failed"; note: Note; codeRefused: boolean }
  | { type: "code-checked" }
  | { type: "hold-started"; until: number; lead: string }
  | { type: "hold-ended" }

export function initialState(reference: string, hold: Hold | null, reveal: Reveal | null = null): OrderState {
  return { reference, seq: 0, now: 0, invoice: null, view: null, record: null, cardSubmittedAt: null, cardFailed: false, reveal, busy: null, note: null, hold, price: null, gone: false, codeRefused: false, codeKept: false }
}

const start = (s: OrderState, action: Action): OrderState => ({ ...s, busy: action, note: null })
const end = (s: OrderState, action: Action, change: Partial<OrderState>): OrderState => s.busy === action ? { ...s, busy: null, ...change } : s

function apply(s: OrderState, e: OrderEvent): OrderState {
  switch (e.type) {
    case "answered":
      if (e.seq <= s.seq) return s
      return { ...s, seq: e.seq, now: e.now, invoice: e.invoice, view: e.view, record: e.record, cardSubmittedAt: e.cardSubmittedAt }
    case "record-changed": return { ...s, record: e.record, cardSubmittedAt: e.cardSubmittedAt }
    case "read-failed": return s
    case "not-found": return { ...s, gone: true }
    case "tick": return { ...s, now: e.now }
    case "card-submitted": return { ...s, cardSubmittedAt: e.at }
    case "card-failed": return { ...s, cardFailed: true }
    case "card-started": return start(s, "card")
    case "card-refused": return end(s, "card", { note: e.note })
    case "reveal-sent": return { ...s, reveal: { key: e.key, sending: true, refusals: s.reveal?.key === e.key ? s.reveal.refusals : 0 } }
    case "reveal-refused": return s.reveal?.key === e.key ? { ...s, reveal: { ...s.reveal, sending: false, refusals: s.reveal.refusals + 1 } } : s
    case "reveal-failed": return s.reveal?.key === e.key ? { ...s, reveal: { ...s.reveal, sending: false } } : s
    case "reveal-retried": return s.reveal ? { ...s, reveal: { ...s.reveal, refusals: 0 } } : s
    case "cancel-started": return start(s, "cancel")
    case "cancel-answered": return end(s, "cancel", { note: e.note })
    case "cancel-failed": return end(s, "cancel", { note: e.note })
    case "reorder-started": return start(s, "reorder")
    case "reorder-failed": return end(s, "reorder", { note: e.note })
    case "price-changed": return end(s, "reorder", { price: e.price })
    case "code-started": return start(s, "code")
    case "code-failed": return end(s, "code", { note: e.note })
    case "retry-started": return start(s, "retry")
    case "retry-failed": return end(s, "retry", { note: e.note, codeRefused: e.codeRefused })
    case "code-checked": return { ...s, codeKept: true }
    case "hold-started": return { ...s, busy: null, note: null, hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: e.lead } }
    case "hold-ended": return { ...s, hold: null }
  }
}

const RETRY_CODE_NOTES: Record<CodeRefusal | "code_reserved", [string, string]> = {
  code_used: ["Your code was used for another name", "A code registers one name only."],
  code_reserved: ["Your code is held by another registration; try again later", ""],
  code_invalid: ["This code is not valid", "The service no longer accepts it."],
  code_expired: ["This code has expired", "An expired code cannot pay for a name."],
}

// The service's refusal of a retry for the order's code, with the error to keep when no later retry gets past it.
export function retryRefusal(error: string): { note: Note; kept: CodeRefusal | null } | null {
  if (!Object.hasOwn(RETRY_CODE_NOTES, error)) return null
  const known = error as keyof typeof RETRY_CODE_NOTES
  const [title, text] = RETRY_CODE_NOTES[known]
  return { note: { tone: "warn", icon: "key", title, text }, kept: known === "code_reserved" ? null : known }
}

// A refusal this browser kept shows with the failed page itself, so a reload never offers Try again first.
function keptRefusal(s: OrderState): OrderState {
  const kept = s.record?.codeRefusal
  const refusal = kept ? retryRefusal(kept) : null
  return refusal?.kept && !s.codeRefused && s.busy === null && screenOf(s) === "failed" ? { ...s, note: refusal.note, codeRefused: true } : s
}

export function reduce(state: OrderState, event: OrderEvent): OrderState {
  const next = apply(state, event)
  if (next === state || screenOf(next) === screenOf(state)) return keptRefusal(next)
  return keptRefusal({ ...next, busy: null, note: null, codeRefused: false, codeKept: false, hold: next.hold && { ...next.hold, lead: NO_LEAD } })
}

// The code is said to be kept only once the service says so; a browser that restored the order has not got its code.
export const failedLead = ({ invoice, codeRefused, codeKept, record }: OrderState) => invoice ? "Your payment is kept. Trying again charges nothing."
  : codeRefused ? "Your code can no longer pay for it, so trying again cannot register it."
  : record?.prepaidCode && codeKept ? "Your code is kept. Trying again spends nothing more." : "Trying again spends nothing more."

export const coinOf = (invoice: InvoiceView) => invoice.cryptoCurrency === "btc" || invoice.cryptoCurrency === "xmr" ? invoice.cryptoCurrency : null

export function screenOf(s: OrderState): OrderKind {
  if (s.gone) return "status:unknown-link"
  if (s.price !== null) return "status:price-changed"
  const { invoice, view, record } = s
  if (!view) return "status:unreadable"
  if (closedCase(s)) return "status:closed"
  if (invoice && view.phase === "unpaid") return paymentKind(s, invoice)
  if (view.phase === "unpaid") return "status:paid-by-invoice"
  if (view.phase === "registered") return "registered"
  if (view.phase === "taken") return "taken"
  if (view.phase === "code_issued") return "code-issued"
  if (view.phase === "failed") return "failed"
  if (view.phase !== "registering" && view.label === null && !record) return "not-on-device"
  return "registering"
}

// An unpaid order's invoice that takes no more payment: closed, or cancelled while the service still shows it open.
export function closedCase({ invoice, view, record }: OrderState): ClosedCase | null {
  if (!invoice || view?.phase !== "unpaid") return null
  if (invoice.status === "paid") return "paid-late"
  if (invoice.status === "open") return record?.cancelled && !invoice.paidInFull ? "still-open" : null
  if (record?.cancelled && !holdsPayment(invoice)) return "cancelled"
  return holdsPayment(invoice) ? "received" : "expired"
}

function paymentKind(s: OrderState, invoice: InvoiceView): OrderKind {
  if (coinOf(invoice)) return invoice.paidInFull ? "confirming" : "pay-crypto"
  if (!s.cardSubmittedAt && !invoice.amountPaid) return s.cardFailed ? "status:card-unconfirmed" : "pay-card"
  const slow = s.record !== null && s.cardSubmittedAt !== null && s.now >= Date.parse(s.cardSubmittedAt) + CARD_SLOW_MS
  return slow ? "status:card-unconfirmed" : "confirming"
}

export const revealKey = (view: RegistrationView) => `${view.id} ${view.commitment} ${view.intentNonce} ${view.revealBefore}`

export function refusalsOf({ view, reveal }: OrderState): number {
  return view?.phase === "committed" && reveal?.key === revealKey(view) ? reveal.refusals : 0
}

export function revealDue(s: OrderState): boolean {
  const { view, record, reveal } = s
  if (view?.phase !== "committed" || view.label !== null || !record) return false
  if ((view.revealAfter ?? 0) * 1000 > s.now) return false
  return !(reveal?.key === revealKey(view) && reveal.sending) && refusalsOf(s) < REVEAL_ATTEMPTS
}

// A moment counts as reached at its own millisecond, so a tick landing on it changes the page.
export function wakeAt(s: OrderState): number | null {
  const { invoice, view, record, cardSubmittedAt, now } = s
  const moments = [
    invoice?.status === "open" && !coinOf(invoice) && record && cardSubmittedAt ? Date.parse(cardSubmittedAt) + CARD_SLOW_MS : null,
    view?.phase === "committed" && view.revealAfter !== null ? view.revealAfter * 1000 : null,
  ].filter((at): at is number => at !== null && at > now)
  return moments.length ? Math.min(...moments) : null
}
