import type { Method } from "../api.ts"
import type { AppliedCode, Checkout } from "../session.ts"
import { type Hold, NO_LEAD } from "./hold.ts"

export const FALLBACK_METHOD: Record<Method, Method> = { card: "btc", btc: "xmr", xmr: "btc" }

export type Refusal = "price-changed" | "too-many" | "failed"
export type CheckoutKind = "checkout" | `status:${Refusal}`

export interface WaitingOrder { registrationId: string; invoiceId: string }
interface OpenOrder { invoiceId: string; label: string; tld: string; confirming: boolean }

export interface CheckoutState {
  checkout: Checkout
  sending: boolean
  busy: boolean
  waiting: WaitingOrder | null
  openOrder: OpenOrder | null
  hold: Hold | null
  refusal: Refusal | null
}

export type CheckoutEvent =
  | { type: "opened"; checkout: Checkout; sending: boolean; waiting: WaitingOrder | null; hold: Hold | null }
  | { type: "method-chosen"; method: Method }
  | { type: "link-set"; kind: "contact" | "channel"; link: string }
  | { type: "code-applied"; code: AppliedCode }
  | { type: "code-removed" }
  | { type: "saved"; saved: boolean }
  | { type: "waiting-settled" }
  | { type: "open-order-seen"; order: OpenOrder }
  | { type: "send-started" }
  | { type: "order-refused"; reason: "code"; error: string }
  | { type: "order-refused"; reason: "method" | "failed" }
  | { type: "price-changed"; price: number }
  | { type: "hold-started"; until: number }
  | { type: "hold-ended" }

export function initialState(checkout: Checkout): CheckoutState {
  return { checkout, sending: false, busy: false, waiting: null, openOrder: null, hold: null, refusal: null }
}

export function changeOf({ checkout }: CheckoutState, e: CheckoutEvent): Partial<Checkout> | null {
  switch (e.type) {
    case "method-chosen": return e.method === checkout.method || e.method === checkout.unavailable ? null : { method: e.method }
    case "link-set": return e.kind === "contact" ? { contact: e.link } : { channel: e.link }
    case "code-applied": return { code: e.code, codeError: undefined }
    case "code-removed": return { code: null }
    case "saved": return { saved: e.saved }
    case "order-refused":
      if (e.reason === "code") return { code: null, codeError: e.error }
      return e.reason === "method" ? { unavailable: checkout.method, method: FALLBACK_METHOD[checkout.method] } : null
    case "price-changed": return { price: e.price }
    default: return null
  }
}

const unsent = (s: CheckoutState, change: Partial<CheckoutState>): CheckoutState => ({ ...s, sending: false, busy: false, ...change })

export function reduce(s: CheckoutState, e: CheckoutEvent): CheckoutState {
  const change = changeOf(s, e)
  const checkout = change ? { ...s.checkout, ...change } : s.checkout
  switch (e.type) {
    case "opened": return { ...s, checkout: e.checkout, sending: e.sending, busy: false, waiting: e.waiting, hold: e.hold, refusal: null }
    case "method-chosen":
    case "link-set":
    case "code-applied":
    case "code-removed":
    case "saved": return change ? { ...s, checkout } : s
    case "waiting-settled": return { ...s, waiting: null }
    case "open-order-seen": return { ...s, openOrder: e.order }
    case "send-started": return { ...s, sending: true, busy: true }
    case "order-refused": return unsent(s, { checkout, refusal: e.reason === "failed" ? "failed" : null })
    case "price-changed": return unsent(s, { checkout, refusal: "price-changed" })
    case "hold-started": return unsent(s, { hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: NO_LEAD }, refusal: "too-many" })
    case "hold-ended": return { ...s, hold: null }
  }
}

export function screenOf(s: CheckoutState): CheckoutKind {
  return s.refusal ? `status:${s.refusal}` : "checkout"
}
