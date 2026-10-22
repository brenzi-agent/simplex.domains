// The names service's HTTP API, on the page's own origin.
import { MAX_LABEL_LENGTH } from "./names.ts"

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfter: number | null
  readonly body: Record<string, unknown>
  constructor(code: string, status: number, retryAfter: number | null, body: Record<string, unknown>) {
    super(code)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
    this.body = body
  }
}

// How long to wait before asking again: what a rate limit asks for, or the usual pause. Null for a refusal that asking
// again cannot change, such as a request this device's clock signed outside the service's window.
export function retryDelay(e: unknown, usual: number): number | null {
  if (!(e instanceof ApiError)) return usual
  if (e.retryAfter) return e.retryAfter * 1000
  if (e.code === "rate_limited") return usual
  return e.status >= 400 && e.status < 500 ? null : usual
}

export type Phase = "unpaid" | "queued" | "committing" | "committed" | "registering" | "registered" | "taken" | "failed"
export type Method = "card" | "btc" | "xmr"

export interface ChainInfo {
  resolver: string
  sponsor: string
  chainId: number
  tld: string
}

export const LINK_KINDS = ["contact", "channel"] as const
export interface Links {
  contact: string
  channel: string
}

export type SearchAnswer =
  | ({ status: "available"; price: number; currency: string; years: number; termStart: number } & ChainInfo)
  | { status: "registered"; entities: Entity[]; records?: Links | null; owner?: string; resolver?: string; recordsNonce?: number | null; expiresAt?: number; gracePeriod?: number; chainId?: number; tld: string }
  | { status: "reserved" }

export type ChatKind = "contact" | "channel" | "business" | "bot"
// whether the service read the link's data: not now (unread), or never, for a host it does not fetch (unavailable)
const PROFILE_STATES = ["ok", "unread", "unavailable"] as const
// the profile a link opens, as the app's connection alert shows it; only a channel counts subscribers
export interface Profile {
  type: "address" | "channel"
  kind: ChatKind
  displayName: string
  fullName: string
  image: string | null
  subscribers: number | null
  profile: typeof PROFILE_STATES[number]
}
export interface Entity extends Profile {
  link: string
  deepLink: string
}

export interface RegistrationView extends ChainInfo {
  id: string
  // counts the service's changes to the registration, which a long poll holds on
  version: number
  phase: Phase
  labelHash: string
  label: string | null
  owner: string
  commitment: string
  sealed: string
  years: number
  // the term in seconds the commitment holds: the paid years and the free days until the term starts
  duration: number
  // what the order is worth, in cents: what was paid, or the price of the name it moved to; it caps another move
  price: number
  // how often the order moved to another name or other links, which the service bounds
  moves: number
  commitTx: string | null
  registerTx: string | null
  revealAfter: number | null
  revealBefore: number | null
  intentNonce: number | null
  // the fields left null because the service's chain read failed; reading the view again may fill them
  unread: string[]
  expiresAt: number | null
  error: string | null
}

export interface InvoiceView {
  invoiceId: string
  status: "open" | "paid" | "expired"
  amount: number
  currency: string
  expiresAt: string
  kind: "name"
  registration: RegistrationView
  amountPaid?: number
  cryptoAmountPaid?: string
  cryptoAmountDue?: string
  paidInFull?: boolean
  settledAt?: string
  clientSecret?: string
  address?: string
  cryptoAmount?: string
  cryptoCurrency?: Method
  requiredConfirmations?: number
}

export const holdsPayment = (inv: InvoiceView) => Boolean(inv.amountPaid) || Number(inv.cryptoAmountPaid ?? "0") > 0 || inv.paidInFull === true

// an invoice closed with nothing received, whose order a new invoice can take over
export const closedEmpty = (inv: InvoiceView | null) => inv?.status === "expired" && !holdsPayment(inv)

interface OrderRequest {
  labelHash: string
  length: number
  duration: number
  owner: string
  commitment: string
  sealed: string
}
// an order as sent, signed by its owner at a time the service checks
export type SignedOrder = OrderRequest & { timestamp: number; signature: string }

// A request is given up after this long, so a hung one never blocks the page for good. Long polls hold as long as
// the service decides; a link edit answers once it is mined, which a fee bump can stretch to minutes.
const REQUEST_TIMEOUT_MS = 60_000
const EDIT_TIMEOUT_MS = 10 * 60_000
// a wait asked for longer than this is taken as this long, as the badge web client does
const MAX_RETRY_AFTER_S = 300
const TOO_MANY_REQUESTS = 429
// a proxy's answer when the service is down or slow: the request may never have reached the service
const GATEWAY_FAILURES = [502, 503, 504]
// a rate limit that names no wait is waited out for this long
export const LIMITED_WAIT_S = 30
// The service's times are read against its clock, which each answer's Date header gives to the second; a device off by less than this is taken as right.
const CLOCK_SLACK_MS = 2000
let clockOffsetMs = 0
// counts changes of the offset, so a request signed before one can be signed again
let clockChanges = 0
export const serviceNow = () => Date.now() + clockOffsetMs
export const clockVersion = () => clockChanges

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
  // one controller for the caller's signal and the time limit, without AbortSignal.any, which older browsers lack
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal?.addEventListener("abort", onAbort)
  if (signal?.aborted) stop.abort()
  const timer = timeoutMs === null ? undefined : setTimeout(onAbort, timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(path, {
        method, signal: stop.signal,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      if (signal?.aborted) throw e
      throw new ApiError("network", 0, null, {})
    }
    const date = Date.parse(res.headers.get("date") ?? "")
    if (Number.isFinite(date)) {
      const offset = Math.abs(date - Date.now()) > CLOCK_SLACK_MS ? date - Date.now() : 0
      if (offset !== clockOffsetMs) clockChanges++
      clockOffsetMs = offset
    }
    // a body cut off on its way is no answer, even after a 200
    const json = await res.json().catch(() => null)
    if (json === null && res.ok) throw new ApiError("network", 0, null, {})
    return answer<T>(res, json ?? {})
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

// Retry-After is seconds or an HTTP date
function retryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = /^\d+$/.test(header.trim()) ? Number(header) : Math.ceil((Date.parse(header) - serviceNow()) / 1000)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : null
}

function answer<T>(res: Response, json: Record<string, unknown>): T {
  if (!res.ok) {
    const retry = retryAfter(res.headers.get("retry-after"))
    // a rate limit or a gateway failure a proxy answers carries no error code of the service's
    const code = res.status === TOO_MANY_REQUESTS ? "rate_limited"
      : typeof json.error === "string" ? json.error
      : GATEWAY_FAILURES.includes(res.status) ? "network" : "internal"
    throw new ApiError(code, res.status, retry, json)
  }
  return json as T
}

// An answer the page cannot draw, or holding what cannot be (a negative price, an unknown state), is no answer, as a body cut off is.
const noAnswer = () => new ApiError("network", 0, null, {})
async function checked<T>(answer: Promise<unknown>, drawable: (a: Record<string, unknown>) => boolean): Promise<T> {
  const a = await answer
  if (!isObject(a) || !drawable(a)) throw noAnswer()
  return a as T
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isText = (v: unknown) => typeof v === "string"
const isAmount = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 1
const isDecimal = (v: unknown) => typeof v === "string" && /^\d+(\.\d+)?$/.test(v)
const optional = (v: unknown, test: (v: unknown) => boolean) => v === undefined || test(v)
const nullable = (v: unknown, test: (v: unknown) => boolean) => v === null || test(v)
// an image the page holds itself, as the service sends it: the page's CSP loads images from nowhere else
const isImage = (v: unknown) => v === null || (typeof v === "string" && v.startsWith("data:image/"))
const CHAT_KINDS: ChatKind[] = ["contact", "channel", "business", "bot"]
// a channel's record holds a channel; an address's, any other kind of chat
const isPreview = (e: unknown) => isObject(e) && (e.type === "address" || e.type === "channel") && CHAT_KINDS.includes(e.kind as ChatKind)
  && (e.type === "channel") === (e.kind === "channel") && isText(e.displayName)
  && isText(e.fullName) && isImage(e.image) && nullable(e.subscribers, isAmount) && PROFILE_STATES.includes(e.profile as Profile["profile"])
const isEntity = (e: unknown) => isPreview(e) && isText((e as Record<string, unknown>).link) && isText((e as Record<string, unknown>).deepLink)
const isChain = (a: Record<string, unknown>) => isText(a.resolver) && isText(a.sponsor) && typeof a.chainId === "number" && isText(a.tld)
const PHASES: Phase[] = ["unpaid", "queued", "committing", "committed", "registering", "registered", "taken", "failed"]
const isRegistration = (v: unknown) => isObject(v) && isChain(v) && isText(v.id) && Number.isInteger(v.version) && PHASES.includes(v.phase as Phase) && isText(v.labelHash)
  && nullable(v.label, isText) && isText(v.owner) && isText(v.commitment) && isText(v.sealed) && isCount(v.years) && isCount(v.duration) && isAmount(v.price) && Number.isInteger(v.moves)
  && nullable(v.commitTx, isText) && nullable(v.registerTx, isText) && nullable(v.revealAfter, isAmount) && nullable(v.revealBefore, isAmount)
  && nullable(v.intentNonce, isAmount) && Array.isArray(v.unread) && v.unread.every(isText) && nullable(v.expiresAt, isAmount) && nullable(v.error, isText)
const isInvoice = (v: unknown) => isObject(v) && isText(v.invoiceId) && ["open", "paid", "expired"].includes(v.status as string) && isAmount(v.amount)
  && isText(v.currency) && isText(v.expiresAt) && isRegistration(v.registration) && optional(v.amountPaid, isAmount)
  && optional(v.cryptoAmountPaid, isDecimal) && optional(v.cryptoAmountDue, isDecimal) && optional(v.cryptoAmount, isDecimal)
  && optional(v.paidInFull, (x) => typeof x === "boolean") && optional(v.address, isText)
  && optional(v.cryptoCurrency, (x) => ["card", "btc", "xmr"].includes(x as string)) && optional(v.requiredConfirmations, (x) => Number.isInteger(x) && (x as number) >= 0)
const isRecords = (v: unknown) => isObject(v) && isText(v.contact) && isText(v.channel)

export const searchName = (labelHash: string, length: number) => checked<SearchAnswer>(call("GET", `/api/name/${labelHash}?length=${length}`), (a) =>
  a.status === "reserved"
  || (a.status === "available" && isAmount(a.price) && isCount(a.years) && isAmount(a.termStart) && isText(a.currency) && isChain(a))
  || (a.status === "registered" && isText(a.tld) && Array.isArray(a.entities) && a.entities.every(isEntity) && optional(a.owner, isText)
    && optional(a.resolver, isText) && optional(a.records, (r) => nullable(r, isRecords)) && optional(a.recordsNonce, (n) => nullable(n, isAmount))
    && optional(a.expiresAt, isAmount) && optional(a.gracePeriod, isAmount) && optional(a.chainId, isAmount)))
export const previewLink = (link: string) => checked<Profile>(call("POST", "/api/link/preview", { link }), isPreview)
const CODE_STATES = ["unused", "used", "reserved", "expired", "unpaid", "revoked"] as const
export type CodeState = typeof CODE_STATES[number]
interface CodeAnswer { minLength: number; years: number; state: CodeState }
export async function checkCode(code: string, signal?: AbortSignal): Promise<CodeAnswer> {
  const answer: unknown = await call("POST", "/api/code/check", { code }, signal)
  const drawable = isObject(answer) && isCount(answer.minLength) && (answer.minLength as number) <= MAX_LABEL_LENGTH && isCount(answer.years)
    && CODE_STATES.includes(answer.state as CodeState)
  if (!drawable) throw noAnswer()
  return answer as unknown as CodeAnswer
}

export const createOrder = (order: SignedOrder, method: Method, price: number) =>
  checked<InvoiceView>(call("POST", "/api/invoice", { kind: "name", ...order, method, price }), isInvoice)
export const registerWithCode = (order: SignedOrder, code: string) =>
  checked<{ registrationId: string }>(call("POST", "/api/name/register", { ...order, code }), (a) => isText(a.registrationId))
export const cancelInvoice = (invoiceId: string) => checked<InvoiceView>(call("POST", `/api/invoice/${encodeURIComponent(invoiceId)}/cancel`), isInvoice)

// what a long poll on an invoice has seen: its status, its registration's version, and the payment marks, the paid amount
// and paidInFull, as Monero can report a full payment with no amount yet
interface SeenInvoice { status: string; version: number; paid: string; full: boolean }
export const seenOf = (inv: InvoiceView): SeenInvoice => ({ status: inv.status, version: inv.registration.version, paid: inv.cryptoAmountPaid ?? "", full: inv.paidInFull === true })

export function readInvoice(invoiceId: string, seen?: SeenInvoice, signal?: AbortSignal): Promise<InvoiceView> {
  const query = seen ? `?wait=${seen.status}&seenVersion=${seen.version}&seenPaid=${encodeURIComponent(seen.paid)}&seenFull=${seen.full ? "1" : "0"}` : ""
  return checked<InvoiceView>(call("GET", `/api/invoice/${encodeURIComponent(invoiceId)}${query}`, undefined, signal, seen ? null : REQUEST_TIMEOUT_MS), isInvoice)
}

export function readRegistration(registrationId: string, seenVersion?: number, signal?: AbortSignal): Promise<RegistrationView> {
  const held = seenVersion !== undefined
  return checked<RegistrationView>(call("GET", `/api/registration/${encodeURIComponent(registrationId)}${held ? `?seenVersion=${seenVersion}` : ""}`, undefined, signal, held ? null : REQUEST_TIMEOUT_MS), isRegistration)
}

export const reveal = (registrationId: string, body: { label: string; secret: string; records: { contact: string[]; channel: string[] }; nonce: number; deadline: number; signature: string }) =>
  call<Record<string, never>>("POST", `/api/registration/${encodeURIComponent(registrationId)}/reveal`, body)
export const retarget = (registrationId: string, body: Omit<SignedOrder, "owner">) =>
  checked<RegistrationView>(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/name`, body), isRegistration)
export const retry = (registrationId: string) => checked<RegistrationView>(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/retry`), isRegistration)
const isFound = (r: unknown) => isObject(r) && isText(r.registrationId) && nullable(r.invoiceId, isText) && PHASES.includes(r.phase as Phase) && isText(r.createdAt)
  && isText(r.labelHash) && isText(r.sealed)
export interface FoundOrder { registrationId: string; invoiceId: string | null; phase: Phase; createdAt: string; labelHash: string; sealed: string }
export const findRegistrations = (owner: string, timestamp: number, signature: string) =>
  checked<{ registrations: FoundOrder[] }>(
    call("POST", "/api/registration/find", { owner, timestamp, signature }), (a) => Array.isArray(a.registrations) && a.registrations.every(isFound))
export const editRecord = (body: { labelHash: string; key?: string; value?: string; clear?: boolean; nonce: number; deadline: number; signature: string }) =>
  checked<{ tx: string | null }>(call("POST", "/api/name/records", body, undefined, EDIT_TIMEOUT_MS), (a) => nullable(a.tx, isText))
