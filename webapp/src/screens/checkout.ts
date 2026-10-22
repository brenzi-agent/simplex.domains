import type { Balance, Method } from "../api.ts"
import type { LinkKind } from "../names.ts"
import { appliedBalance, type Checkout } from "../session.ts"
import { type Hold, NO_LEAD } from "./hold.ts"
import type { CheckoutStep } from "./routes.ts"

export const FALLBACK_METHOD: Record<Method, Method> = { card: "btc", btc: "xmr", xmr: "btc" }

export type Refusal = "price-changed" | "too-many" | "failed" | "taken"
export type CheckoutKind = CheckoutStep | `status:${Refusal}`

export interface WaitingOrder { registrationId: string; invoiceId: string }
interface OpenOrder { invoiceId: string; confirming: boolean }

export interface CheckoutState {
  step: CheckoutStep
  checkout: Checkout
  sending: boolean
  busy: boolean
  waiting: WaitingOrder | null
  openOrder: OpenOrder | null
  hold: Hold | null
  refusal: Refusal | null
}

export type CheckoutEvent =
  | { type: "opened"; step: CheckoutStep; checkout: Checkout; sending: boolean; waiting: WaitingOrder | null; hold: Hold | null }
  | { type: "link-set"; kind: LinkKind; link: string }
  | { type: "saved"; saved: boolean }
  | { type: "agreed"; agreed: boolean }
  | { type: "method-chosen"; method: Method }
  | { type: "waiting-settled" }
  | { type: "open-order-seen"; order: OpenOrder | null }
  | { type: "send-started" }
  | { type: "order-refused"; reason: "code"; error: string }
  | { type: "order-refused"; reason: "method" | "failed" | "taken" }
  | { type: "price-changed"; price: number }
  | { type: "balance-changed"; balance: Balance | null }
  | { type: "hold-started"; until: number }
  | { type: "hold-ended" }

export function initialState(checkout: Checkout, step: CheckoutStep): CheckoutState {
  return { step, checkout, sending: false, busy: false, waiting: null, openOrder: null, hold: null, refusal: null }
}

export function changeOf({ checkout }: CheckoutState, e: CheckoutEvent): Partial<Checkout> | null {
  switch (e.type) {
    case "link-set": return e.kind === "contact" ? { contact: e.link } : { channel: e.link }
    case "saved": return { saved: e.saved }
    case "agreed": return { agreed: e.agreed }
    case "method-chosen": return e.method === checkout.method || e.method === checkout.unavailable ? null : { method: e.method }
    case "order-refused":
      if (e.reason === "code") return { code: null, codeError: e.error }
      return e.reason === "method" ? { unavailable: checkout.method, method: FALLBACK_METHOD[checkout.method] } : null
    case "price-changed": return { price: e.price }
    case "balance-changed": {
      const balance = checkout.balance && appliedBalance(checkout.balance.source, e.balance)
      return { balance, balanceChange: !balance ? "gone" : balance.heldUntil ? "held" : "changed" }
    }
    default: return null
  }
}

const unsent = (s: CheckoutState, change: Partial<CheckoutState>): CheckoutState => ({ ...s, sending: false, busy: false, ...change })

export function reduce(s: CheckoutState, e: CheckoutEvent): CheckoutState {
  const change = changeOf(s, e)
  const checkout = change ? { ...s.checkout, ...change } : s.checkout
  switch (e.type) {
    case "opened": return { ...s, step: e.step, checkout: e.checkout, sending: e.sending, busy: false, waiting: e.waiting, hold: e.hold, refusal: null }
    case "link-set":
    case "saved":
    case "agreed":
    case "method-chosen": return change ? { ...s, checkout } : s
    case "waiting-settled": return { ...s, waiting: null }
    case "open-order-seen": return { ...s, openOrder: e.order }
    case "send-started": return { ...s, sending: true, busy: true }
    case "order-refused": return unsent(s, { checkout, refusal: e.reason === "failed" || e.reason === "taken" ? e.reason : null })
    case "price-changed": return unsent(s, { checkout, refusal: "price-changed" })
    case "balance-changed": return unsent(s, { checkout })
    case "hold-started": return unsent(s, { hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: NO_LEAD }, refusal: "too-many" })
    case "hold-ended": return { ...s, hold: null }
  }
}

// What the checkout's balance pays of the price, and the rest, which an invoice pays; a balance held by an open invoice
// pays the same, as the service takes it once that invoice closes.
export function split(c: Checkout): { fromBalance: number; rest: number } {
  const fromBalance = Math.min(c.balance?.amount ?? 0, c.price)
  return { fromBalance, rest: c.price - fromBalance }
}

// an order its balance covers is paid by nothing else
export const covered = (c: Checkout) => c.balance !== null && split(c).rest === 0

// the review opens once the name code is saved
export function stepFor(c: Checkout, asked: CheckoutStep): CheckoutStep {
  return asked === "review" && !(c.ownerCode && c.saved) ? "code" : asked
}

export function screenOf(s: CheckoutState): CheckoutKind {
  return s.refusal ? `status:${s.refusal}` : s.step
}
