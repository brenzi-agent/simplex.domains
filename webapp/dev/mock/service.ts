// A stand-in for StoreService's names API, driving the real contracts on the local chain.
// A development fixture: memory only, no money, and not a specification of the real service.
import { createHash, randomBytes } from "node:crypto"
import {
  encodeFunctionData, getAddress, hashTypedData, isAddress, keccak256, namehash, recoverAddress, recoverMessageAddress, recoverTypedDataAddress, toHex,
  zeroHash, type Address, type Hex,
} from "viem"
import type { ChatKind, Profile } from "../../src/api.ts"
import { codeHash, parseNameCode } from "../../src/crypto/code.ts"
import { CHANNEL_KEY, CONTACT_KEY, durationFor, YEAR_S } from "../../src/crypto/registration.ts"
import { labelProblem, linkKind, type LinkKind, linkProblem, MAX_LABEL_LENGTH, MIN_LABEL_LENGTH } from "../../src/names.ts"
import {
  baseRegistrar, chainNow, controller, deployment, holder, mined, NotSent, ownerOf, priceOracleAt, read, registry, resolver, Reverted, send, sponsor,
} from "./chain.ts"
import { TERM_START_S, untilChainTime } from "../chain-time.ts"
import { addressFor } from "./addresses.ts"
import { deepLinkOf } from "./links.ts"

const YEARS = 2
// SimplexPriceOracle's attoUSD to the cent
const ATTO_PER_CENT = 10n ** 16n
// how far an order's free days may be from the service's own count: the page's clock is set from the service's Date header
const TERM_SLACK_S = 3600
// rates for the crypto amounts, in dollars
const RATES = { btc: 64000, xmr: 160 }
const INVOICE_MINUTES = 60

function wholeEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, not "${raw}"`)
  return Number(raw)
}

// how long a long poll holds before answering unchanged
const HOLD_MS = 20_000
const SIGNED_REQUEST_SECONDS = 600
// find lists an owner's newest orders, at most this many
const FOUND_MAX = 50
// the service's max_order_moves: an order moves to another name or other links at most this often
const MAX_ORDER_MOVES = 3
// how long a register with no answer is followed on chain before it counts as failed: 12 × 5 s
const PENDING_CHECKS = 12
const PENDING_CHECK_MS = 5000
// a registered name's expiry is read a few times, inside a request the page waits 60 s for
const EXPIRY_READS = 3
const EXPIRY_READ_MS = 1000
const RESEND_MS = wholeEnv("MOCK_RESEND_MS", 5000)
const RESENDS = wholeEnv("MOCK_RESENDS", 12)
// what an order shows for a chain that failed it; the provider's own error carries its URL, which can hold an API key
const CHAIN_FAILED = "The blockchain did not answer"
// a contract's revert name is no message for a buyer
const REFUSED = "The blockchain refused the transaction"
const SEALED_MAX = 11095
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

export type Phase = "unpaid" | "queued" | "committing" | "committed" | "registering" | "registered" | "taken" | "failed" | "code_issued"
type Method = "card" | "btc" | "xmr"

interface Registration {
  id: string
  invoiceId: string | null
  labelHash: Hex
  length: number
  duration: number
  owner: Address
  commitment: Hex
  sealed: string
  years: number
  paid: number
  method: Method | "code"
  // the hash of the prepaid code that pays for it; a code issued for a taken order is known only by its hash
  prepaidCode: string | null
  phase: Phase
  // counts every change to what the view shows; long polls hold on it, and every write is conditional on it
  version: number
  label: string | null
  secret: Hex | null
  records: { contact: string[]; channel: string[] } | null
  intent: { nonce: bigint; deadline: bigint; signature: Hex } | null
  commitTx: Hex | null
  registerTx: Hex | null
  revealAfter: number | null
  revealBefore: number | null
  expiresAt: number | null
  error: string | null
  createdAt: string
  failNext: boolean
  issuedCodeHash: string | null
  // the minLength of the code issued for it, which the code's text carries
  issuedCodeLength: number | null
  // successful moves to another name or other links, at most MAX_ORDER_MOVES
  moves: number
  // a reveal refused for its links, which only a move to other links can fix
  linksRefused: boolean
  // what an exact resend of the order that made it must repeat: its fields, never its timestamp or signature
  orderHash: string
  // tries of a transaction that did not go out, since the last that did
  resends: number
}

interface Invoice {
  id: string
  registrationId: string
  method: Method
  status: "open" | "paid" | "expired"
  amount: number
  expiresAt: string
  cryptoAmount: string | null
  amountPaid: number | null
  cryptoAmountPaid: string | null
  cryptoAmountDue: string | null
  paidInFull: boolean | null
  settledAt: string | null
  clientSecret: string | null
}

interface PrepaidCode {
  minLength: number
  years: number
  state: "unused" | "reserved" | "used" | "revoked" | "expired" | "unpaid"
  registrationId: string | null
}

const registrations = new Map<string, Registration>()
const invoices = new Map<string, Invoice>()
const codes = new Map<string, PrepaidCode>()
const waiters = new Map<string, Set<() => void>>()
// labels the control endpoint is registering to someone else, which a registration waits for
const taking = new Map<string, Promise<void>>()
// the next createInvoice answers with this error once, to show the checkout's refusals;
// find has a rate limit of its own
// until unsentUntil, no transaction goes out, as a chain that fails before the send; until unreadUntil, the view's own chain
// reads fail; each write to a registration waits writeDelayMs before its check, so a test can race two
// the next reveal finds its links refused, as the service's link check would if it no longer took what the page took
const control: { chainDown: boolean; limitedUntil: number; invoiceError: string | null; findLimitedUntil: number; unsentUntil: number; unreadUntil: number; writeDelayMs: number; refuseLinks: boolean } =
  { chainDown: false, limitedUntil: 0, invoiceError: null, findLimitedUntil: 0, unsentUntil: 0, unreadUntil: 0, writeDelayMs: 0, refuseLinks: false }

const sendTx: typeof send = (...args) => Date.now() < control.unsentUntil ? Promise.reject(new NotSent()) : send(...args)
const INVOICE_ERRORS: Record<string, number> = { provider_unavailable: 503, rate_limited: 429, catalog_changed: 409, internal: 500 }
// the raised price an injected catalog_changed reports, in cents
const RAISED_PRICE_CENTS = 5000
const RETRY_AFTER_SECONDS = wholeEnv("MOCK_RETRY_AFTER_SECONDS", 30)

export class HttpError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly retryAfter: number | null
  constructor(status: number, error: string, extra: Record<string, unknown> = {}, retryAfter: number | null = null) {
    super(error)
    this.status = status
    this.body = { error, ...extra }
    this.retryAfter = retryAfter
  }
}

const badRequest = (extra: Record<string, unknown> = {}) => new HttpError(400, "bad_request", extra)
const id = () => randomBytes(16).toString("base64url")
const nowSeconds = () => Math.floor(Date.now() / 1000)
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z")
const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The oracle prices by length only, so a label of as many letters "a" quotes every label of that length, and the label
// itself never reaches the node. A failed read throws.
async function priceOf(length: number, years: number): Promise<number> {
  const quote = await read<{ base: bigint }>(controller, "rentPriceUSD", ["a".repeat(length), BigInt(years * YEAR_S)])
  return Number(quote.base / ATTO_PER_CENT)
}

// --- long poll

function publish(...keys: (string | null)[]): void {
  for (const key of keys) {
    if (key === null) continue
    const set = waiters.get(key)
    waiters.delete(key)
    set?.forEach((wake) => wake())
  }
}

// the registration changed; an invoice changing alone only wakes its polls
function changed(reg: Registration): void {
  reg.version += 1
  wake(reg)
}

const wake = (reg: Registration) => publish(reg.id, reg.invoiceId)

// A write to a registration is a compare-and-set on the version its request read: one that lost a race changes nothing.
async function unchangedSince(reg: Registration, version: number): Promise<void> {
  if (control.writeDelayMs) await sleep(control.writeDelayMs)
  if (reg.version !== version) throw new HttpError(409, "registration_changed", { registration: await registrationView(reg) })
}

async function hold(key: string, unchanged: () => boolean): Promise<void> {
  if (!unchanged()) return
  await new Promise<void>((resolve) => {
    const set = waiters.get(key) ?? new Set()
    const wake = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { set.delete(wake); resolve() }, HOLD_MS)
    set.add(wake)
    waiters.set(key, set)
  })
}

// --- the chain, by hash: the service sends its own transactions, so it reads names from the contracts itself

type Lookup =
  | { type: "available" }
  | { type: "reserved" }
  | { type: "registered"; owner: Address; resolver: Address; expires: number; grace: number }

async function lookup(labelHash: Hex): Promise<Lookup> {
  if (control.chainDown) throw new HttpError(503, "provider_unavailable")
  try {
    const token = BigInt(labelHash)
    const [expires, grace, now, reason] = await Promise.all([
      read<bigint>(baseRegistrar, "nameExpires", [token]),
      read<bigint>(baseRegistrar, "GRACE_PERIOD"),
      chainNow(),
      read<number>(controller, "reservedNames", [labelHash]),
    ])
    // a name in its grace period is still its holder's; a name never registered expires at 0
    if (expires > 0n && expires + grace >= BigInt(now)) {
      const node = nodeOf(labelHash)
      const [owner, nameResolver] = await Promise.all([read<Address>(registry, "owner", [node]), read<Address>(registry, "resolver", [node])])
      return { type: "registered", owner: getAddress(owner), resolver: getAddress(nameResolver), expires: Number(expires), grace: Number(grace) }
    }
    return reason === 0 ? { type: "available" } : { type: "reserved" }
  } catch {
    throw new HttpError(503, "provider_unavailable")
  }
}

// a name being registered here is not on chain until its transaction is mined
function registering(labelHash: Hex): boolean {
  return [...registrations.values()].some((r) => r.labelHash === labelHash && r.phase === "registering")
}

// a text record may hold several links, joined as the app joins them
const LINK_SEPARATOR = ";"
const splitLinks = (text: string) => text.split(LINK_SEPARATOR).map((l) => l.trim()).filter(Boolean)
// a record set elsewhere may hold any number of links; a search answers the first few of each key
const MAX_ENTITIES_PER_KEY = 5

// --- link cards

const KNOWN_PROFILES: Record<string, Pick<Profile, "displayName" | "fullName" | "subscribers">> = {
  "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS": { displayName: "Alice's Bakery", fullName: "Sourdough and pastries, Lisbon", subscribers: null },
  "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm": { displayName: "Bakery news", fullName: "Daily bakes and opening hours", subscribers: 1204 },
}

// A contact link's fragment says what profile the tests want behind it: a business, a bot, a profile with a picture, or
// none, as for a host the service does not fetch.
const BUSINESS_TAG = "Biz"
const BOT_TAG = "Bot"
const PICTURE_TAG = "Pic"
const UNFETCHED_TAG = "Off"
// a profile picture as the app sends one, a small image in a data URI
const PICTURE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#C76A3B"/><circle cx="32" cy="26" r="12" fill="#F6E3C8"/><path d="M12 60c2-14 10-20 20-20s18 6 20 20z" fill="#F6E3C8"/></svg>').toString("base64")}`

function linkProfile(link: string): Profile | null {
  const kind = linkKind(link)
  if (kind === null) return null
  const fragment = link.split("#")[1].slice(0, 6)
  const known = KNOWN_PROFILES[link]
  const type = kind === "contact" ? "address" : "channel"
  if (fragment.startsWith(UNFETCHED_TAG)) return { type, kind, displayName: "", fullName: "", image: null, subscribers: null, profile: "unavailable" }
  const chat: ChatKind = kind === "channel" ? "channel" : fragment.startsWith(BUSINESS_TAG) ? "business" : fragment.startsWith(BOT_TAG) ? "bot" : "contact"
  // a channel's count, the same for the same link
  const subscribers = kind === "channel" ? [...fragment].reduce((n, c) => n * 7 + c.charCodeAt(0), 0) % 5000 : null
  return {
    type, kind: chat, profile: "ok",
    displayName: known?.displayName ?? (kind === "contact" ? `Contact ${fragment}` : `Channel ${fragment}`),
    fullName: known?.fullName ?? "", image: fragment.startsWith(PICTURE_TAG) ? PICTURE : null, subscribers: known ? known.subscribers : subscribers,
  }
}

function entity(link: string) {
  const profile = linkProfile(link)
  return profile && { ...profile, link, deepLink: deepLinkOf(link) }
}

// the short links of the key's kind in its record, in the record's order
const entitiesOf = (kind: LinkKind, text: string) =>
  splitLinks(text).filter((link) => linkProblem(kind, link) === null).slice(0, MAX_ENTITIES_PER_KEY).map(entity).filter((e) => e !== null)

// --- search

export async function search(hash: string, lengthText: string | null): Promise<Record<string, unknown>> {
  if (control.limitedUntil > Date.now()) throw new HttpError(429, "rate_limited", {}, Math.ceil((control.limitedUntil - Date.now()) / 1000))
  if (!isHash(hash)) throw badRequest()
  const length = Number(lengthText)
  if (!Number.isInteger(length) || length < MIN_LABEL_LENGTH || length > MAX_LABEL_LENGTH) throw new HttpError(400, "invalid_name")
  const found = await lookup(hash)
  const chain = { chainId: deployment.chainId, tld: deployment.tld }
  if (found.type === "reserved") return { status: "reserved" }
  if (found.type === "available") {
    if (registering(hash)) return { status: "registered", entities: [], tld: deployment.tld }
    const price = await priceOf(length, YEARS).catch(unavailable)
    return { status: "available", price, currency: "usd", years: YEARS, termStart: TERM_START_S, resolver: deployment.resolver, sponsor: deployment.sponsor, ...chain }
  }
  // Records are read only from the store's own resolver: calling whatever contract a name points at would let anyone
  // make the service run arbitrary code. A name pointed elsewhere is shown with its owner and no links.
  if (found.resolver !== getAddress(deployment.resolver)) {
    return { status: "registered", entities: [], records: null, owner: found.owner, resolver: found.resolver, recordsNonce: null, expiresAt: found.expires, gracePeriod: found.grace, ...chain }
  }
  const node = nodeOf(hash)
  let contact: string, channel: string, nonce: bigint
  try {
    [contact, channel, nonce] = await Promise.all([
      read<string>(resolver, "text", [node, CONTACT_KEY]),
      read<string>(resolver, "text", [node, CHANNEL_KEY]),
      read<bigint>(resolver, "nonces", [found.owner]),
    ])
  } catch {
    // a failed read is not "no links": the page says the name could not be checked
    throw new HttpError(503, "provider_unavailable")
  }
  const entities = [...entitiesOf("contact", contact), ...entitiesOf("channel", channel)]
  return { status: "registered", entities, records: { contact, channel }, owner: found.owner, resolver: found.resolver, recordsNonce: Number(nonce), expiresAt: found.expires, gracePeriod: found.grace, ...chain }
}

function nodeOf(labelHash: Hex): Hex {
  return keccak256(`${namehash(deployment.tld)}${labelHash.slice(2)}` as Hex)
}

// --- views

// a failed chain read is the provider's, not the request's
const unavailable = (): never => { throw new HttpError(503, "provider_unavailable") }

// a chain read the view needs, or null when it fails: the view still answers, naming the field in unread
async function viewRead<T>(field: string, unread: string[], f: () => Promise<T>): Promise<T | null> {
  try {
    if (Date.now() < control.unreadUntil) throw new Error("the chain is not answering")
    return await f()
  } catch {
    unread.push(field)
    return null
  }
}

async function registrationView(reg: Registration): Promise<Record<string, unknown>> {
  const unread: string[] = []
  const intentNonce = reg.phase === "committed" ? await viewRead("intentNonce", unread, async () => Number(await read<bigint>(sponsor, "nonces", [reg.owner]))) : null
  const codeLength = reg.phase === "code_issued" ? reg.issuedCodeLength
    : reg.phase === "taken" && reg.method !== "code" ? await viewRead("codeLength", unread, () => codeLengthFor(reg)) : null
  return {
    id: reg.id, version: reg.version, moves: reg.moves, phase: reg.phase, labelHash: reg.labelHash, label: reg.label, owner: reg.owner, commitment: reg.commitment, sealed: reg.sealed,
    resolver: deployment.resolver, sponsor: deployment.sponsor, chainId: deployment.chainId, tld: deployment.tld, years: reg.years, duration: reg.duration, price: reg.paid,
    commitTx: reg.commitTx, registerTx: reg.registerTx, revealAfter: reg.revealAfter, revealBefore: reg.revealBefore,
    codeLength, intentNonce, unread, expiresAt: reg.expiresAt, error: reg.error,
  }
}

async function invoiceView(inv: Invoice): Promise<Record<string, unknown>> {
  const view: Record<string, unknown> = {
    invoiceId: inv.id, status: inv.status, amount: inv.amount, currency: "usd", expiresAt: inv.expiresAt, kind: "name",
    registration: await registrationView(registrations.get(inv.registrationId)!),
  }
  for (const k of ["amountPaid", "cryptoAmountPaid", "cryptoAmountDue", "paidInFull", "settledAt"] as const) if (inv[k] !== null) view[k] = inv[k]
  if (inv.method === "card") view.clientSecret = inv.clientSecret
  else Object.assign(view, { address: addressFor(inv.method, inv.id), cryptoAmount: inv.cryptoAmount, cryptoCurrency: inv.method, requiredConfirmations: 1 })
  return view
}

// --- orders

interface OrderBody {
  labelHash: Hex
  length: number
  duration: number
  owner: Address
  commitment: Hex
  sealed: string
}

function orderBody(body: Record<string, unknown>): OrderBody {
  const { labelHash, length, duration, owner, commitment, sealed } = body
  if (!isHash(labelHash) || !isHash(commitment) || !Number.isInteger(duration)) throw badRequest()
  if (typeof owner !== "string" || !isAddress(owner, { strict: true }) || getAddress(owner) !== owner) throw badRequest()
  if (typeof sealed !== "string" || sealed.length > SEALED_MAX) throw badRequest()
  if (typeof length !== "number" || !Number.isInteger(length) || length < MIN_LABEL_LENGTH || length > MAX_LABEL_LENGTH) throw new HttpError(400, "invalid_name")
  return { labelHash, length, duration: duration as number, owner, commitment, sealed }
}

// the paid years and the free days until the term starts, as the page counts them by the service's clock
function checkDuration(duration: number, years: number): void {
  const free = duration - years * YEAR_S
  if (free < 0 || Math.abs(free - Math.max(0, TERM_START_S - nowSeconds())) > TERM_SLACK_S) throw badRequest()
}

// A taken order's code pays for any name no dearer than the order: the shortest length from which every longer one costs,
// for the order's years, at most what the order is worth; null when no length does. The whole price list is read once.
async function codeLengthFor(reg: Registration): Promise<number | null> {
  const oracle = priceOracleAt(await read<Address>(controller, "prices"))
  const [base, exceptions] = await read<[bigint, { labelLength: bigint; priceCentsPerYear: bigint }[]]>(oracle, "prices")
  const perYear = new Map(exceptions.map((e) => [Number(e.labelLength), e.priceCentsPerYear]))
  const affordable = (length: number) => Number(perYear.get(length) ?? base) * reg.years <= reg.paid
  let shortest: number | null = null
  for (let length = MAX_LABEL_LENGTH; length >= MIN_LABEL_LENGTH && affordable(length); length--) shortest = length
  return shortest
}

// an order's own chain reads fail with their own tag, which the page tells from a payment method being unavailable
const chainPrice = (length: number, years: number) => priceOf(length, years).catch((): never => { throw new HttpError(503, "name_check_unavailable") })

async function nameFree(labelHash: Hex): Promise<void> {
  let found: Lookup
  try {
    found = await lookup(labelHash)
  } catch {
    throw new HttpError(503, "name_check_unavailable")
  }
  if (found.type !== "available" || registering(labelHash)) throw new HttpError(409, "name_taken")
}

// Orders, retargets and taken codes check state, await the chain, then write: run one at a time so two at once cannot both pass.
let orderTurn: Promise<unknown> = Promise.resolve()

export function oneOrderAtATime<T>(f: () => Promise<T>): Promise<T> {
  const run = orderTurn.then(f)
  orderTurn = run.catch(() => undefined)
  return run
}

// An order's own fields, tagged by its kind, as an exact resend repeats them.
const orderHashOf = (kind: "invoice" | "register", o: OrderBody, extra: unknown[]) =>
  createHash("sha256").update(JSON.stringify([kind, o.labelHash, o.length, o.duration, o.owner, o.commitment, o.sealed, ...extra])).digest("hex")

// The owner signs every order, so nobody can place one in another wallet's name; its age is checked only for a new order.
async function checkOrderSigner(o: OrderBody, body: Record<string, unknown>): Promise<void> {
  if (!Number.isInteger(body.timestamp)) throw badRequest()
  const message = `simplex.domains order ${o.labelHash} ${o.length} ${o.duration} ${o.commitment} ${sha256Hex(o.sealed)} ${body.timestamp}`
  if (await recoverMessageAddress({ message, signature: checkSignature(body.signature) }) !== o.owner) throw badRequest()
}

const freshTimestamp = (timestamp: unknown) => { if (Math.abs(nowSeconds() - (timestamp as number)) > SIGNED_REQUEST_SECONDS) throw badRequest() }

// A registration is live while its invoice is open, or once paid until it is taken or turned into a code.
function live(reg: Registration): boolean {
  if (reg.phase === "unpaid") return reg.invoiceId !== null && invoices.get(reg.invoiceId)!.status === "open"
  return reg.phase !== "taken" && reg.phase !== "code_issued"
}

// The answer to an exact resend, or nothing; an overdue order of the same wallet and name with nothing received is closed
// by this one first, and any other live order of the commitment, or of the wallet and name, refuses it without saying
// anything of itself.
function existingOrder(o: OrderBody, orderHash: string | null, except: Registration | null = null): Registration | null {
  const resent = orderHash === null ? undefined : [...registrations.values()].find((r) => r.orderHash === orderHash)
  if (resent) return resent
  const meets = (r: Registration) => r !== except && (r.commitment === o.commitment || (r.owner === o.owner && r.labelHash === o.labelHash))
  for (const r of registrations.values()) if (meets(r) && r.invoiceId) expireIfDue(invoices.get(r.invoiceId)!)
  if ([...registrations.values()].some((r) => meets(r) && live(r))) throw new HttpError(409, "order_exists")
  return null
}

export async function createInvoice(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (body.kind !== "name") throw badRequest()
  const order = orderBody(body)
  const method = body.method
  if (method !== "card" && method !== "btc" && method !== "xmr") throw badRequest()
  if (!Number.isInteger(body.price)) throw badRequest()
  const injected = control.invoiceError
  if (injected) {
    control.invoiceError = null
    const extra = injected === "catalog_changed" ? { price: await chainPrice(order.length, YEARS) + RAISED_PRICE_CENTS } : {}
    throw new HttpError(INVOICE_ERRORS[injected], injected, extra, injected === "rate_limited" ? RETRY_AFTER_SECONDS : null)
  }
  await checkOrderSigner(order, body)
  const orderHash = orderHashOf("invoice", order, [method, body.price])
  const resent = existingOrder(order, orderHash)
  if (resent) return invoiceView(invoices.get(resent.invoiceId!)!)
  freshTimestamp(body.timestamp)
  checkDuration(order.duration, YEARS)
  await nameFree(order.labelHash)
  const price = await chainPrice(order.length, YEARS)
  if (body.price !== price) throw new HttpError(409, "catalog_changed", { price })
  const reg = newRegistration(order, { years: YEARS, paid: price, method, prepaidCode: null, phase: "unpaid", orderHash })
  const inv: Invoice = {
    id: id(), registrationId: reg.id, method, status: "open", amount: price,
    expiresAt: iso(nowSeconds() + INVOICE_MINUTES * 60),
    cryptoAmount: method === "card" ? null : (price / 100 / RATES[method]).toFixed(method === "btc" ? 5 : 3),
    amountPaid: null, cryptoAmountPaid: null, cryptoAmountDue: null, paidInFull: null, settledAt: null,
    clientSecret: method === "card" ? `pi_mock_secret_${randomBytes(12).toString("hex")}` : null,
  }
  reg.invoiceId = inv.id
  invoices.set(inv.id, inv)
  return invoiceView(inv)
}

function newRegistration(order: OrderBody, extra: Pick<Registration, "years" | "paid" | "method" | "prepaidCode" | "phase" | "orderHash">): Registration {
  const reg: Registration = {
    id: id(), invoiceId: null, ...order, ...extra, label: null, secret: null, records: null, intent: null, commitTx: null, registerTx: null,
    revealAfter: null, revealBefore: null, expiresAt: null, error: null, createdAt: iso(nowSeconds()), failNext: false, issuedCodeHash: null, issuedCodeLength: null, moves: 0, linksRefused: false, resends: 0, version: 1,
  }
  registrations.set(reg.id, reg)
  return reg
}

export async function readInvoice(invoiceId: string, wait: string | null, seenVersion: number | null, seenPaid: string | null, seenFull: boolean): Promise<Record<string, unknown>> {
  const inv = invoices.get(invoiceId)
  if (!inv) throw new HttpError(404, "not_found")
  expireIfDue(inv)
  const reg = registrations.get(inv.registrationId)!
  lapse(reg)
  // a name invoice paid after it closed has nothing more to wait for
  const lateAndUnpaid = inv.status === "paid" && reg.phase === "unpaid"
  if (wait !== null && !lateAndUnpaid) {
    await hold(inv.id, () => inv.status === wait && (seenVersion === null || reg.version === seenVersion) && (seenPaid === null || ((inv.cryptoAmountPaid ?? "") === seenPaid && (inv.paidInFull === true) === seenFull)))
    expireIfDue(inv)
  }
  return invoiceView(inv)
}

export async function readRegistration(registrationId: string, seenVersion: number | null): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  lapse(reg)
  if (seenVersion !== null) await hold(reg.id, () => reg.version === seenVersion)
  return registrationView(reg)
}

// An open invoice past its rate window with no money received expires when it is next looked at; a funded one stays
// open until it settles.
function expireIfDue(inv: Invoice): void {
  if (inv.status === "open" && inv.amountPaid === null && Date.parse(inv.expiresAt) <= Date.now()) {
    inv.status = "expired"
    wake(registrations.get(inv.registrationId)!)
  }
}

export async function cancelInvoice(invoiceId: string): Promise<Record<string, unknown>> {
  const inv = invoices.get(invoiceId)
  if (!inv) throw new HttpError(404, "not_found")
  expireIfDue(inv)
  if (inv.status !== "open") throw new HttpError(409, "not_open")
  if (inv.amountPaid) throw new HttpError(409, "funded")
  inv.status = "expired"
  wake(registrations.get(inv.registrationId)!)
  return invoiceView(inv)
}

// --- prepaid codes

function prepaidOf(text: unknown): { hash: string; row: PrepaidCode | undefined } {
  const code = typeof text === "string" ? parseNameCode(text) : null
  if (code?.kind !== "prepaid") throw new HttpError(400, "code_invalid")
  const hash = codeHash(code.canonical)
  return { hash, row: codes.get(hash) }
}

export function checkCode(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.code !== "string") throw badRequest()
  const { row } = prepaidOf(body.code)
  if (!row) throw new HttpError(400, "code_invalid")
  return { minLength: row.minLength, years: row.years, state: row.state }
}

const CODE_ERRORS: Partial<Record<PrepaidCode["state"], string>> = { used: "code_used", reserved: "code_reserved", expired: "code_expired", unpaid: "payment_pending", revoked: "code_invalid" }

export async function registerWithCode(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const order = orderBody(body)
  const { hash, row } = prepaidOf(body.code)
  if (!row) throw new HttpError(400, "code_invalid")
  await checkOrderSigner(order, body)
  const orderHash = orderHashOf("register", order, [hash])
  const resent = existingOrder(order, orderHash)
  if (resent) return { registrationId: resent.id }
  freshTimestamp(body.timestamp)
  checkDuration(order.duration, row.years)
  await nameFree(order.labelHash)
  const error = CODE_ERRORS[row.state]
  if (error) throw new HttpError(error === "code_invalid" ? 400 : 409, error)
  if (order.length < row.minLength) throw new HttpError(409, "code_not_covering")
  const reg = newRegistration(order, { years: row.years, paid: 0, method: "code", prepaidCode: hash, phase: "queued", orderHash })
  row.state = "reserved"
  row.registrationId = reg.id
  void advance(reg)
  return { registrationId: reg.id }
}

// the controller's minimum registration is 2 years, and codes cover names of 6 to 63 letters
const CODE_YEARS = { min: 2, max: 10 }
const CODE_STATES: PrepaidCode["state"][] = ["unused", "reserved", "used", "revoked", "expired", "unpaid"]

// A code's state set from outside, as an order elsewhere taking it, or letting it go
export function setCodeState(code: unknown, state: unknown): Record<string, unknown> {
  const parsed = typeof code === "string" ? parseNameCode(code) : null
  const row = parsed?.kind === "prepaid" ? codes.get(codeHash(parsed.canonical)) : undefined
  if (!row || !CODE_STATES.includes(state as PrepaidCode["state"])) throw badRequest()
  row.state = state as PrepaidCode["state"]
  if (row.state === "unused") row.registrationId = null
  return { ok: true }
}

export function issueCode(minLength: number, years: number, state: PrepaidCode["state"]): string {
  if (!Number.isInteger(years) || years < CODE_YEARS.min || years > CODE_YEARS.max) throw badRequest()
  if (!Number.isInteger(minLength) || minLength < MIN_LABEL_LENGTH || minLength > MAX_LABEL_LENGTH || !CODE_STATES.includes(state)) throw badRequest()
  const lengthText = String(minLength)
  for (;;) {
    // a random body with a valid check character: draw until the parser accepts one
    const payload = [...randomBytes(19)].map((b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("")
    for (const c of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") {
      const code = parseNameCode(`SN${lengthText}${payload}${c}`)
      if (code?.kind === "prepaid") {
        codes.set(codeHash(code.canonical), { minLength, years, state, registrationId: null })
        return code.display
      }
    }
  }
}

// --- the worker: commit, wait, register

const busy = new Set<string>()

async function advance(reg: Registration): Promise<void> {
  if (busy.has(reg.id)) return
  busy.add(reg.id)
  try {
    // a commit that did not go out stays committing while it is tried again
    if (reg.phase === "queued" || reg.phase === "committing") await commit(reg)
    if (reg.phase === "committed" && reg.intent) await register(reg)
    reg.resends = 0
  } catch (e) {
    if (e instanceof NotSent && reg.resends < RESENDS) {
      reg.resends += 1
      setTimeout(() => void advance(reg), RESEND_MS)
    } else fail(reg, e instanceof Reverted ? REFUSED : CHAIN_FAILED)
  } finally {
    busy.delete(reg.id)
  }
}

// A commitment not revealed before revealBefore can no longer register: the order fails, for Try again to commit afresh.
function lapse(reg: Registration): void {
  if (reg.phase === "committed" && !reg.intent && reg.revealBefore !== null && nowSeconds() > reg.revealBefore) fail(reg, "The name was not signed in time")
}

function fail(reg: Registration, error: string): void {
  // a failed registration keeps its prepaid code reserved for Try again
  reg.phase = "failed"
  reg.error = error
  changed(reg)
}

async function commit(reg: Registration): Promise<void> {
  reg.phase = "committing"
  changed(reg)
  if (reg.failNext) {
    reg.failNext = false
    return fail(reg, "The blockchain did not take the commit")
  }
  for (;;) {
    try {
      // kept once its receipt is in: the order's page reads a commit hash as a commit on chain
      reg.commitTx = await sendTx(controller, "commit", [reg.commitment])
      reg.resends = 0
    } catch (e) {
      // an earlier commit of the same commitment is still live
      if (!(e instanceof Reverted && e.revert === "UnexpiredCommitmentExists")) throw e
    }
    const at = Number(await read<bigint>(controller, "commitments", [reg.commitment]))
    // a commit the wall clock calls lapsed can still be live on chain for a few blocks; reusing it would lapse at once
    if (at + deployment.maxCommitmentAge > nowSeconds()) break
    await sleep(1000)
  }
  const committedAt = Number(await read<bigint>(controller, "commitments", [reg.commitment]))
  reg.revealAfter = committedAt + deployment.minCommitmentAge
  reg.revealBefore = committedAt + deployment.maxCommitmentAge
  if (reg.intent && reg.intent.deadline !== BigInt(reg.revealBefore)) clearReveal(reg)
  reg.phase = "committed"
  changed(reg)
}

function clearReveal(reg: Registration): void {
  reg.label = null
  reg.secret = null
  reg.records = null
  reg.intent = null
}

function registrationTuple(reg: Registration) {
  const node = namehash(`${reg.label}.${deployment.tld}`)
  const records: [string, string[]][] = [[CONTACT_KEY, reg.records!.contact], [CHANNEL_KEY, reg.records!.channel]]
  const data = records.filter(([, links]) => links.length > 0)
    .map(([key, links]) => encodeFunctionData({ abi: resolver.abi, functionName: "setText", args: [node, key, links.join(";")] }))
  return {
    label: reg.label!, owner: reg.owner, duration: BigInt(reg.duration), secret: reg.secret!, resolver: deployment.resolver, data, reverseRecord: 0, referrer: zeroHash,
  }
}

async function register(reg: Registration): Promise<void> {
  await untilChainTime(reg.revealAfter!, chainNow)
  await taking.get(reg.label!)
  if (reg.failNext) {
    reg.failNext = false
    return fail(reg, "The register transaction did not go through")
  }
  const { nonce, deadline, signature } = reg.intent!
  // registering only once the transaction goes out: until then the name is not on its way to the owner
  const sending = (hash: Hex) => {
    reg.phase = "registering"
    reg.registerTx = hash
    changed(reg)
  }
  try {
    reg.registerTx = await sendTx(sponsor, "registerWithCredit", [registrationTuple(reg), nonce, deadline, signature], sending)
  } catch (e) {
    if (e instanceof NotSent) throw e
    // no answer from the chain is not a failure: the transaction may still be mined, so the order waits for the chain
    if (!(e instanceof Reverted)) return awaitRegistration(reg)
    if ((await ownerOf(reg.labelHash).catch(() => null)) === reg.owner) return registered(reg)
    // another registration by the same owner spent this nonce first: the owner signs again with the next one
    if (e.revert === "InvalidNonce") {
      clearReveal(reg)
      reg.phase = "committed"
      return changed(reg)
    }
    const available = await read<boolean>(controller, "available", [reg.label])
    if (!available) {
      reg.phase = "taken"
      reg.error = "Another registration took the name first"
      if (reg.prepaidCode) releaseCode(reg)
      return changed(reg)
    }
    return fail(reg, REFUSED)
  }
  // the transaction went through; the owner is checked as the chain answers it, and a read that fails leaves it at that
  const holder = await ownerOf(reg.labelHash).catch(() => reg.owner)
  if (holder !== reg.owner) return fail(reg, "Registered to another address")
  await registered(reg)
}

// A register whose sending got no answer: the chain is asked for a while whether the name came to its owner.
async function awaitRegistration(reg: Registration): Promise<void> {
  for (let i = 0; i < PENDING_CHECKS; i++) {
    await new Promise((resolve) => setTimeout(resolve, PENDING_CHECK_MS))
    if ((await ownerOf(reg.labelHash).catch(() => null)) === reg.owner) return registered(reg)
  }
  fail(reg, "The register transaction got no answer from the blockchain")
}

// a few tries, as one failed read is the provider's moment, not the registration's
async function registered(reg: Registration): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      reg.expiresAt = Number(await read<bigint>(baseRegistrar, "nameExpires", [BigInt(reg.labelHash)]))
      break
    } catch (e) {
      if (i + 1 >= EXPIRY_READS) throw e
      await new Promise((resolve) => setTimeout(resolve, EXPIRY_READ_MS))
    }
  }
  reg.phase = "registered"
  reg.error = null
  if (reg.prepaidCode) {
    const row = codes.get(reg.prepaidCode)
    if (row) row.state = "used"
  }
  changed(reg)
}

function releaseCode(reg: Registration): void {
  const row = codes.get(reg.prepaidCode!)
  if (row && row.registrationId === reg.id && row.state === "reserved") {
    row.state = "unused"
    row.registrationId = null
  }
}

// --- the reveal

function checkSignature(signature: unknown): Hex {
  if (typeof signature !== "string" || !/^0x[0-9a-f]{130}$/.test(signature)) throw badRequest()
  const s = BigInt("0x" + signature.slice(66, 130))
  const v = parseInt(signature.slice(130), 16)
  // the sponsor's and resolver's SignatureChecker take only a low s and v 27 or 28
  if (s > SECP256K1_HALF_N || (v !== 27 && v !== 28)) throw badRequest()
  return signature as Hex
}

// at most one link per key, each text; whether they are links the service takes is checked last
function linksOf(records: unknown): { contact: string[]; channel: string[] } {
  if (typeof records !== "object" || records === null) throw badRequest()
  const out = { contact: [] as string[], channel: [] as string[] }
  for (const kind of ["contact", "channel"] as const) {
    const links = (records as Record<string, unknown>)[kind]
    if (!Array.isArray(links) || links.length > 1 || !links.every((l) => typeof l === "string")) throw badRequest()
    out[kind].push(...links)
  }
  return out
}

const linksTaken = (records: { contact: string[]; channel: string[] }) =>
  (["contact", "channel"] as const).every((kind) => records[kind].every((link) => linkProblem(kind, link) === null))

export async function reveal(registrationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  lapse(reg)
  const signature = checkSignature(body.signature)
  if (reg.label !== null) {
    if (reg.label === body.label && reg.intent?.signature === signature) return {}
    throw badRequest()
  }
  if (reg.phase !== "committed") throw badRequest()
  const version = reg.version
  const { label, secret, nonce, deadline } = body
  if (typeof label !== "string" || labelProblem(label) !== null) throw badRequest()
  if (keccak256(toHex(label)) !== reg.labelHash || label.length !== reg.length) throw badRequest()
  if (!isHash(secret) || typeof nonce !== "number" || typeof deadline !== "number" || !Number.isInteger(nonce) || !Number.isInteger(deadline)) throw badRequest()
  const records = linksOf(body.records)
  const candidate = { ...reg, label, secret, records }
  const tuple = registrationTuple(candidate)
  if ((await read<Hex>(controller, "makeCommitment", [tuple]).catch(unavailable)) !== reg.commitment) throw badRequest()
  if (deadline < nowSeconds()) throw badRequest()
  const signer = await recoverTypedDataAddress({
    domain: { name: "SimplexSponsor", version: "1", chainId: deployment.chainId, verifyingContract: deployment.sponsor },
    types: {
      RegisterName: [
        { name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "duration", type: "uint256" },
        { name: "resolver", type: "address" }, { name: "data", type: "bytes[]" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "RegisterName",
    message: { label, owner: reg.owner, duration: tuple.duration, resolver: deployment.resolver, data: tuple.data, nonce: BigInt(nonce), deadline: BigInt(deadline) },
    signature,
  })
  if (signer !== reg.owner) throw badRequest()
  if (BigInt(nonce) !== (await read<bigint>(sponsor, "nonces", [reg.owner]).catch(unavailable))) throw badRequest()
  // Refused links are the committed ones, as the commitment and the owner's signature passed: only a move fixes them.
  if (reg.linksRefused) throw new HttpError(400, "invalid_link")
  const refuse = control.refuseLinks
  control.refuseLinks = false
  if (refuse || !linksTaken(records)) {
    await unchangedSince(reg, version)
    reg.linksRefused = true
    changed(reg)
    throw new HttpError(400, "invalid_link")
  }
  await unchangedSince(reg, version)
  reg.label = label
  reg.secret = secret
  reg.records = records
  reg.intent = { nonce: BigInt(nonce), deadline: BigInt(deadline), signature }
  changed(reg)
  void advance(reg)
  return {}
}

// --- signed requests from the owner code's key

async function checkSigned(owner: Address, message: string, timestamp: unknown, signature: unknown): Promise<void> {
  if (typeof timestamp !== "number" || Math.abs(nowSeconds() - timestamp) > SIGNED_REQUEST_SECONDS) throw badRequest()
  const signer = await recoverMessageAddress({ message, signature: checkSignature(signature) })
  if (signer !== owner) throw badRequest()
}

const sha256Hex = (text: string) => "0x" + createHash("sha256").update(text, "ascii").digest("hex")

export async function retarget(registrationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  const order = orderBody({ ...body, owner: reg.owner })
  await checkSigned(reg.owner, `simplex.domains name ${reg.id} ${order.labelHash} ${order.length} ${order.duration} ${order.commitment} ${sha256Hex(order.sealed)} ${body.timestamp}`, body.timestamp, body.signature)
  const current = reg.labelHash === order.labelHash && reg.length === order.length && reg.duration === order.duration && reg.commitment === order.commitment && reg.sealed === order.sealed
  if (current) return registrationView(reg)
  lapse(reg)
  // a paid order taken first, any failed order, or one whose reveal was refused for its links
  const movable = (reg.phase === "taken" && reg.method !== "code") || reg.phase === "failed" || (reg.phase === "committed" && reg.linksRefused)
  if (!movable) throw badRequest()
  if (reg.moves >= MAX_ORDER_MOVES) throw new HttpError(409, "move_limit", { registration: await registrationView(reg) })
  const version = reg.version
  existingOrder(order, null, reg)
  checkDuration(order.duration, reg.years)
  await nameFree(order.labelHash)
  const price = reg.method === "code" ? 0 : await chainPrice(order.length, reg.years)
  if (price > reg.paid) throw new HttpError(409, "price_too_high", { price })
  const row = reg.prepaidCode ? codes.get(reg.prepaidCode) : undefined
  if (row) codeStillPays(row, reg, order.length)
  await unchangedSince(reg, version)
  if (row) Object.assign(row, { state: "reserved", registrationId: reg.id })
  // the order now has the new name's price, which caps any later move
  Object.assign(reg, {
    labelHash: order.labelHash, length: order.length, duration: order.duration, commitment: order.commitment, sealed: order.sealed, paid: price,
    moves: reg.moves + 1, phase: "queued", commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, error: null, linksRefused: false,
  })
  clearReveal(reg)
  changed(reg)
  const view = await registrationView(reg)
  void advance(reg)
  return view
}

// A code order's code pays again if it is still this order's, or was released and is still unused, and covers the name.
function codeStillPays(row: PrepaidCode, reg: Registration, length: number): void {
  const error = row.state !== "unused" && row.registrationId !== reg.id ? CODE_ERRORS[row.state] : undefined
  if (error) throw new HttpError(error === "code_invalid" ? 400 : 409, error)
  if (length < row.minLength) throw new HttpError(409, "code_not_covering")
}

export async function takenCode(registrationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  const { codeHash: hash, codeLength } = body
  if (typeof hash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(hash) || !Number.isInteger(codeLength)) throw badRequest()
  await checkSigned(reg.owner, `simplex.domains code ${reg.id} ${hash} ${codeLength} ${body.timestamp}`, body.timestamp, body.signature)
  // a repeat is answered from the code issued, whatever the prices are now
  if (reg.issuedCodeHash === hash) return {}
  if (reg.phase !== "taken" || reg.method === "code") throw badRequest()
  const version = reg.version
  const minLength = await codeLengthFor(reg).catch(unavailable)
  if (minLength === null) throw new HttpError(409, "code_unavailable")
  if (minLength !== codeLength) throw new HttpError(409, "code_length_changed", { codeLength: minLength })
  if (codes.has(hash)) throw new HttpError(409, "code_conflict")
  await unchangedSince(reg, version)
  // the service never sees the code, only its hash; the page shows the code it derived
  codes.set(hash, { minLength, years: reg.years, state: "unused", registrationId: null })
  reg.issuedCodeHash = hash
  reg.issuedCodeLength = minLength
  reg.phase = "code_issued"
  changed(reg)
  return {}
}

export async function retry(registrationId: string): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  lapse(reg)
  if (reg.phase !== "failed") throw badRequest()
  const version = reg.version
  if ((await ownerOf(reg.labelHash).catch(unavailable)) === reg.owner) {
    await unchangedSince(reg, version)
    await registered(reg).catch(unavailable)
    return registrationView(reg)
  }
  const nonce = reg.intent ? await read<bigint>(sponsor, "nonces", [reg.owner]).catch(unavailable) : null
  await unchangedSince(reg, version)
  const row = reg.prepaidCode ? codes.get(reg.prepaidCode) : undefined
  if (row) {
    codeStillPays(row, reg, reg.length)
    Object.assign(row, { state: "reserved", registrationId: reg.id })
  }
  if (reg.intent && reg.intent.nonce !== nonce) clearReveal(reg)
  reg.phase = "queued"
  reg.error = null
  reg.registerTx = null
  reg.resends = 0
  changed(reg)
  const view = await registrationView(reg)
  void advance(reg)
  return view
}

export async function find(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (control.findLimitedUntil > Date.now()) throw new HttpError(429, "rate_limited", {}, Math.ceil((control.findLimitedUntil - Date.now()) / 1000))
  const owner = body.owner
  if (typeof owner !== "string" || !isAddress(owner)) throw badRequest()
  const address = getAddress(owner)
  await checkSigned(address, `simplex.domains find ${address.toLowerCase()} ${body.timestamp}`, body.timestamp, body.signature)
  const found = [...registrations.values()].filter((r) => r.owner === address).reverse().slice(0, FOUND_MAX)
  if (found.length === 0) throw new HttpError(404, "not_found")
  return { registrations: found.map((r) => ({ registrationId: r.id, invoiceId: r.invoiceId, phase: r.phase, createdAt: r.createdAt, labelHash: r.labelHash, sealed: r.sealed })) }
}

export function previewLink(body: Record<string, unknown>): Profile {
  const profile = typeof body.link === "string" ? linkProfile(body.link) : null
  if (!profile || new TextEncoder().encode(body.link as string).length > 4096) throw new HttpError(400, "invalid_link")
  return profile
}

// --- the records relay

// Each sent edit, by its signed body: a repeat is answered from it rather than checked anew. A refused edit is never sent,
// so it is not kept, and its repeat is checked again.
interface SentEdit { hash: Hex; outcome: Record<string, unknown> | HttpError | null }
const sentEdits = new Map<string, SentEdit>()

async function repeatedEdit(sent: SentEdit): Promise<Record<string, unknown>> {
  if (sent.outcome instanceof HttpError) throw sent.outcome
  if (sent.outcome) return sent.outcome
  // one that got no answer goes on: the repeat waits for it again
  let ok: boolean
  try {
    ok = await mined(sent.hash)
  } catch {
    throw new HttpError(504, "edit_pending")
  }
  sent.outcome = ok ? { tx: sent.hash } : new HttpError(409, "record_reverted", { revert: null })
  return repeatedEdit(sent)
}

export async function editRecords(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { labelHash, key, value, nonce, deadline } = body
  if (!isHash(labelHash) || typeof nonce !== "number" || typeof deadline !== "number" || !Number.isInteger(nonce) || !Number.isInteger(deadline)) throw badRequest()
  const signature = checkSignature(body.signature)
  const clear = body.clear === true
  if (!clear) {
    const kind = key === CONTACT_KEY ? "contact" : key === CHANNEL_KEY ? "channel" : null
    if (kind === null || typeof value !== "string") throw badRequest()
    if (value !== "" && linkProblem(kind, value) !== null) throw new HttpError(400, "invalid_link")
  }
  const node = nodeOf(labelHash)
  const domain = { name: "SimplexResolver", version: "1", chainId: deployment.chainId, verifyingContract: deployment.resolver }
  const digest = clear
    ? hashTypedData({ domain, primaryType: "ClearRecords", types: { ClearRecords: [{ name: "node", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, message: { node, nonce: BigInt(nonce), deadline: BigInt(deadline) } })
    : hashTypedData({ domain, primaryType: "SetText", types: { SetText: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }, { name: "value", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, message: { node, key: key as string, value: value as string, nonce: BigInt(nonce), deadline: BigInt(deadline) } })
  const signer = await recoverAddress({ hash: digest, signature })
  const editKey = JSON.stringify([labelHash, clear, key, value, nonce, deadline, signature])
  const earlier = sentEdits.get(editKey)
  if (earlier) return repeatedEdit(earlier)
  if (deadline < nowSeconds()) throw badRequest()
  // a failed chain read is the provider's, not the request's
  let owner: Address, nameResolver: Address, current: bigint
  try {
    // getAddress takes a chain id second, so it is not handed map's index
    [owner, nameResolver] = (await Promise.all([read<Address>(registry, "owner", [node]), read<Address>(registry, "resolver", [node])])).map((a) => getAddress(a))
    current = await read<bigint>(resolver, "nonces", [owner])
  } catch {
    throw new HttpError(503, "provider_unavailable")
  }
  if (signer !== owner) throw badRequest()
  // the relay writes only the store's resolver, which a name pointed elsewhere no longer reads
  if (nameResolver !== getAddress(deployment.resolver)) throw badRequest()
  if (BigInt(nonce) !== current) throw badRequest()
  // kept from the moment it goes out
  const edit: { sent: SentEdit | null } = { sent: null }
  const goingOut = (hash: Hex) => {
    edit.sent = { hash, outcome: null }
    sentEdits.set(editKey, edit.sent)
  }
  try {
    const tx = clear
      ? await sendTx(resolver, "clearRecordsWithSig", [node, BigInt(nonce), BigInt(deadline), signature], goingOut)
      : await sendTx(resolver, "setTextWithSig", [node, key, value, BigInt(nonce), BigInt(deadline), signature], goingOut)
    if (edit.sent) edit.sent.outcome = { tx }
    return { tx }
  } catch (e) {
    if (e instanceof NotSent) throw new HttpError(503, "provider_unavailable")
    // a dry run that reverts sends nothing; a transaction that reverts is the edit's answer
    if (e instanceof Reverted) {
      const reverted = new HttpError(409, "record_reverted", { revert: e.revert })
      if (edit.sent) edit.sent.outcome = reverted
      throw reverted
    }
    // no answer from the chain is not a refusal: the edit may still be mined, which the page says
    throw new HttpError(504, "edit_pending")
  }
}

// --- controls for tests and screenshots

export function controlInvoice(action: string, invoiceId: string): Record<string, unknown> {
  const inv = invoices.get(invoiceId)
  if (!inv) throw new HttpError(404, "not_found")
  expireIfDue(inv)
  const reg = registrations.get(inv.registrationId)!
  if (action === "settle") {
    const wasOpen = inv.status === "open"
    Object.assign(inv, { status: "paid", amountPaid: inv.amount, settledAt: iso(nowSeconds()), paidInFull: true })
    if (inv.method !== "card") Object.assign(inv, { cryptoAmountPaid: inv.cryptoAmount, cryptoAmountDue: "0" })
    if (wasOpen && reg.phase === "unpaid") {
      reg.phase = "queued"
      changed(reg)
      void advance(reg)
    }
  } else if (action === "partial") {
    const half = (Number(inv.cryptoAmount) / 2).toFixed(5)
    Object.assign(inv, { amountPaid: Math.floor(inv.amount / 2), paidInFull: false, cryptoAmountPaid: half, cryptoAmountDue: (Number(inv.cryptoAmount) - Number(half)).toFixed(5) })
  } else if (action === "confirming") {
    Object.assign(inv, { amountPaid: inv.amount, paidInFull: true })
    if (inv.method !== "card") Object.assign(inv, { cryptoAmountPaid: inv.cryptoAmount, cryptoAmountDue: "0" })
  } else if (action === "expire") {
    inv.status = "expired"
  } else if (action === "overdue") {
    inv.expiresAt = iso(nowSeconds())
  } else throw badRequest()
  wake(reg)
  return { ok: true, status: inv.status }
}

export function controlRegistration(action: string, registrationId: string): Record<string, unknown> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  if (action === "fail") reg.failNext = true
  else throw badRequest()
  return { ok: true }
}

// Registers the label to the test holder before a registration waiting on it, as a rival registrar would.
export function controlTake(label: unknown): Record<string, unknown> {
  if (typeof label !== "string" || labelProblem(label) !== null) throw badRequest()
  const done = (async () => {
    const tuple = { label, owner: holder.address, duration: durationFor(YEARS, TERM_START_S, nowSeconds()), secret: toHex(randomBytes(32)), resolver: deployment.resolver, data: [] as Hex[], reverseRecord: 0, referrer: zeroHash }
    const commitment = await read<Hex>(controller, "makeCommitment", [tuple])
    await send(controller, "commit", [commitment])
    await untilChainTime(Number(await read<bigint>(controller, "commitments", [commitment])) + deployment.minCommitmentAge, chainNow)
    const turn = holderTurn.then(() => registerForHolder(tuple))
    holderTurn = turn.catch(() => undefined)
    await turn
  })()
  taking.set(label, done.catch((e) => console.error(`control/take ${label} failed:`, e)))
  return { ok: true }
}

// the holder registers one name at a time: each signature needs the nonce the last one spent
let holderTurn: Promise<unknown> = Promise.resolve()

async function registerForHolder(tuple: { label: string; owner: Address; duration: bigint; secret: Hex; resolver: Address; data: Hex[]; reverseRecord: number; referrer: Hex }): Promise<void> {
  const nonce = await read<bigint>(sponsor, "nonces", [holder.address])
  const deadline = BigInt(nowSeconds() + 3600)
  const signature = await holder.signTypedData({
    domain: { name: "SimplexSponsor", version: "1", chainId: deployment.chainId, verifyingContract: deployment.sponsor },
    types: { RegisterName: [
      { name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "duration", type: "uint256" },
      { name: "resolver", type: "address" }, { name: "data", type: "bytes[]" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] },
    primaryType: "RegisterName",
    message: { ...tuple, nonce, deadline },
  })
  await send(sponsor, "registerWithCredit", [tuple, nonce, deadline, signature])
}

export function controlSearch(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.chainDown === "boolean") control.chainDown = body.chainDown
  if (typeof body.limitSeconds === "number") control.limitedUntil = Date.now() + body.limitSeconds * 1000
  if (body.invoiceError === null || (typeof body.invoiceError === "string" && body.invoiceError in INVOICE_ERRORS)) control.invoiceError = body.invoiceError
  if (typeof body.findLimitSeconds === "number") control.findLimitedUntil = Date.now() + body.findLimitSeconds * 1000
  if (typeof body.unsentSeconds === "number") control.unsentUntil = Date.now() + body.unsentSeconds * 1000
  if (typeof body.unreadSeconds === "number") control.unreadUntil = Date.now() + body.unreadSeconds * 1000
  if (typeof body.writeDelayMs === "number") control.writeDelayMs = body.writeDelayMs
  if (typeof body.refuseLinks === "boolean") control.refuseLinks = body.refuseLinks
  return { ok: true }
}

export function dump(): unknown {
  return { registrations: [...registrations.values()].map((r) => ({ ...r, intent: r.intent && { ...r.intent, nonce: String(r.intent.nonce), deadline: String(r.intent.deadline) } })), invoices: [...invoices.values()] }
}

