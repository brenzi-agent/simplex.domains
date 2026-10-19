// This tab's checkout in progress, which ends with the tab.
import type { ChainInfo, Method } from "./api.ts"

export interface AppliedCode {
  display: string
  minLength: number
  years: number
}

export interface Checkout {
  label: string
  price: number
  chain: ChainInfo
  contact: string
  channel: string
  method: Method
  code: AppliedCode | null
  ownerCode: string | null
  saved: boolean
  // opened from the app: the app wallet's address, and the secret this page keeps for it
  appOwner: string | null
  appSecret: string | null
  // a method the provider refused just now
  unavailable?: Method
  // why the service refused the code this checkout carried
  codeError?: string
}

const CHECKOUT = "simplex-names-checkout"
const SCROLLED = "simplex-names-scrolled"
const memory = new Map<string, string>()
// keys whose last write did not reach sessionStorage, which then holds an older value
const unsaved = new Set<string>()

function read<T>(key: string): T | null {
  let text: string | null
  try {
    text = unsaved.has(key) ? memory.get(key) ?? null : window.sessionStorage.getItem(key)
  } catch {
    text = memory.get(key) ?? null
  }
  try {
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  const text = JSON.stringify(value)
  memory.set(key, text)
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, text)
    unsaved.delete(key)
  } catch {
    unsaved.add(key)
  }
}

// Each entry is written on its own so a page restored from the browser's cache, holding older places, keeps the others.
export const scrolled = (): Record<number, number> => read<Record<number, number>>(SCROLLED) ?? {}
export const setScrolled = (at: number, y: number) => write(SCROLLED, { ...scrolled(), [at]: y })

// a checkout without its name or chain is a leftover of a page that outlived its order, not one to continue
export function checkout(): Checkout | null {
  const c = read<Checkout>(CHECKOUT)
  return c?.label && c.chain ? c : null
}
export const setCheckout = (c: Checkout | null) => write(CHECKOUT, c)

// a page changes only its own name's checkout; once the order took it, a stale page writes nothing
export function updateCheckout(label: string, change: Partial<Checkout>): boolean {
  const c = checkout()
  if (c?.label !== label) return false
  write(CHECKOUT, { ...c, ...change })
  return true
}
// The checkout whose order is on its way: its Pay stays disabled and its links, method and code stay locked meanwhile,
// so a re-ticked box or Back cannot send a second order or change the one sent.
const sending = new Set<string>()
const keyOf = (c: Checkout) => `${c.label} ${c.ownerCode ?? c.appOwner}`
export const isSending = (c: Checkout) => sending.has(keyOf(c))
export const startSending = (c: Checkout) => sending.add(keyOf(c))
export const stopSending = (c: Checkout) => sending.delete(keyOf(c))
