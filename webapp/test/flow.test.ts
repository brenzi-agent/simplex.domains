import { hashMessage, recoverAddress, recoverMessageAddress, type Hex } from "viem"
import type { Phase } from "../src/api.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatOwnerCode } from "../src/crypto/code.ts"
import { commitmentSecret, labelHash, makeCommitment, namehash, registerIntentDigest, setTextDigest, YEAR_S } from "../src/crypto/registration.ts"
import { unseal } from "../src/crypto/seal.ts"
import { checksumAddress, hex, walletFromEntropy } from "../src/crypto/wallet.ts"

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"))
const ENTROPY = fromHex("6f2d1c9a4b7e3f80d15a2c6e9b04f7a3")
const OWNER_CODE = formatOwnerCode(ENTROPY)
const WALLET = walletFromEntropy(ENTROPY)
const OWNER = checksumAddress(WALLET.address)
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
// a term that starts in ten days, so an order carries free days
const TERM_START = Math.floor(Date.now() / 1000) + 10 * 86400
const QUOTE = { status: "available" as const, price: 20000, currency: "usd", years: 2, termStart: TERM_START, ...CHAIN }
const LINKS = { contact: "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS", channel: "" }

type Call = { method: string; path: string; body: Record<string, unknown> }
let calls: Call[]
let answers: Record<string, unknown>

// localStorage for store.ts, and a fetch that records each call and answers from `answers` by "METHOD path"
function fakeBrowser(): void {
  const data = new Map<string, string>()
  vi.stubGlobal("window", {
    localStorage: {
      get length() { return data.size },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  })
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, path, body })
    const key = `${method} ${path.split("?")[0]}`
    if (!(key in answers)) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
    const answer = typeof answers[key] === "function" ? (answers[key] as () => unknown)() : answers[key]
    if (answer instanceof Response) return answer
    return new Response(JSON.stringify(answer), { status: 200 })
  })
}

async function modules() {
  vi.resetModules()
  return { flow: await import("../src/flow.ts"), store: await import("../src/store.ts") }
}

beforeEach(() => {
  calls = []
  answers = {}
  fakeBrowser()
})
afterEach(() => vi.unstubAllGlobals())

const draft = (label = "dynamis") => ({ label, links: LINKS, chain: CHAIN, years: 2, termStart: TERM_START, ownerCode: OWNER_CODE })

function view(request: { labelHash: string; duration: number; commitment: string; sealed: string | null }, extra: Record<string, unknown> = {}) {
  return {
    id: "reg1", version: 1, unread: [], moves: 0, phase: "committed", labelHash: request.labelHash, label: null, owner: OWNER, commitment: request.commitment, sealed: request.sealed,
    years: 2, duration: request.duration, price: 20000, fromBalance: 0, balance: null, commitTx: "0x01", registerTx: null, revealAfter: 1000, revealBefore: 87400, intentNonce: 3, expiresAt: null, error: null, linksRefused: false, latePayment: null,
    ...CHAIN, ...extra,
  }
}

describe("orderRequest", () => {
  it("commits to the label, the code's wallet, its derived secret and the links, and seals the name for the code", async () => {
    const { flow } = await modules()
    const { request, owner } = await flow.orderRequest(draft())
    expect(owner).toBe(OWNER)
    expect(request.labelHash).toBe(hex(labelHash("dynamis")))
    expect(request.length).toBe(7)
    // the paid years and the free days left until the term starts, by the clock at the order
    const free = request.duration - 2 * YEAR_S
    expect(Math.abs(free - (TERM_START - Date.now() / 1000))).toBeLessThan(2)
    const expected = makeCommitment({
      label: "dynamis", tld: "simplex", owner: WALLET.address, duration: BigInt(request.duration), secret: commitmentSecret(WALLET.seed, "dynamis"),
      resolver: fromHex(CHAIN.resolver), contactLinks: [LINKS.contact], channelLinks: [],
    })
    expect(request.commitment).toBe(hex(expected))
    expect(await unseal(WALLET.seed, request.sealed)).toEqual({ label: "dynamis", ...LINKS })
  })

  it("is signed by the code's key over every field but the signature, at the service's time", async () => {
    const { flow } = await modules()
    const { request } = await flow.orderRequest(draft())
    expect(Math.abs(request.timestamp - Date.now() / 1000)).toBeLessThan(2)
    const sealedHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.sealed))).toString("hex")
    const message = `simplex.domains order ${request.labelHash} 7 ${request.duration} ${request.commitment} 0x${sealedHash} ${request.timestamp}`
    expect(await recoverMessageAddress({ message, signature: request.signature as Hex })).toBe(OWNER)
  })
})

describe("revealOrder", () => {
  it("sends the label, secret and links with a RegisterName signature from the code's key, at the commitment's deadline", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/registration/reg1/reveal"] = {}
    await flow.revealOrder(view(built.request) as never, record)
    const body = calls[0].body as { label: string; secret: string; records: unknown; nonce: number; deadline: number; signature: Hex }
    expect(body).toMatchObject({ label: "dynamis", secret: hex(commitmentSecret(WALLET.seed, "dynamis")), records: { contact: [LINKS.contact], channel: [] }, nonce: 3, deadline: 87400 })
    const r = {
      label: "dynamis", tld: "simplex", owner: WALLET.address, duration: BigInt(built.request.duration), secret: fromHex(body.secret),
      resolver: fromHex(CHAIN.resolver), contactLinks: [LINKS.contact], channelLinks: [],
    }
    const digest = registerIntentDigest(31337n, fromHex(CHAIN.sponsor), r, 3n, 87400n)
    expect(await recoverAddress({ hash: hex(digest) as Hex, signature: body.signature })).toBe(OWNER)
  })
})

describe("retargetOrder", () => {
  it("signs the new name's request with the order's key and keeps the record's wallet", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    answers["POST /api/registration/reg1/name"] = view(built.request)
    await flow.retargetOrder(record, "another", LINKS, QUOTE)
    const body = calls[0].body as { labelHash: string; length: number; duration: number; commitment: string; sealed: string; timestamp: number; signature: Hex }
    expect(body.labelHash).toBe(hex(labelHash("another")))
    const sealedHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.sealed))).toString("hex")
    const message = `simplex.domains name reg1 ${body.labelHash} 7 ${body.duration} ${body.commitment} 0x${sealedHash} ${body.timestamp}`
    expect(await recoverMessageAddress({ message, signature: body.signature })).toBe(OWNER)
    expect(store.orderByRegistration("reg1")).toMatchObject({ label: "another", owner: OWNER, request: { labelHash: body.labelHash } })
  })
})

describe("restore", () => {
  it("finds the code's order with a signed request, checks the commitment, and saves the record", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: "inv1", phase: "committed", createdAt: "2026-10-14T10:00:00Z", labelHash: built.request.labelHash, sealed: built.request.sealed, balanceSource: null, heldBy: null }] }
    answers["GET /api/invoice/inv1"] = {
      invoiceId: "inv1", status: "open", amount: 20000, currency: "usd", expiresAt: "2026-10-14T11:00:00Z", kind: "name", cryptoCurrency: "xmr", registration: view(built.request),
    }
    const { record } = await flow.restore(OWNER_CODE.toLowerCase().replaceAll("-", " "))
    expect(record).toMatchObject({ registrationId: "reg1", invoiceId: "inv1", label: "dynamis", ownerCode: OWNER_CODE, owner: OWNER, ...LINKS, paid: 20000, method: "xmr" })
    const find = calls[0].body as { owner: string; timestamp: number; signature: Hex }
    expect(await recoverMessageAddress({ message: `simplex.domains find ${OWNER.toLowerCase()} ${find.timestamp}`, signature: find.signature })).toBe(OWNER)
    expect(store.orderByInvoice("inv1")?.ownerCode).toBe(OWNER_CODE)
  })

  it("restores an order paid wholly from a balance, which has no invoice, as paid by the balance that find names", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg2", invoiceId: null, phase: "queued", createdAt: "2026-10-14T10:00:00Z", labelHash: built.request.labelHash, sealed: built.request.sealed, balanceSource: "reg1", heldBy: null }] }
    answers["GET /api/registration/reg2"] = view(built.request, { id: "reg2", phase: "queued", fromBalance: 20000 })
    const { record } = await flow.restore(OWNER_CODE)
    expect(record).toMatchObject({ registrationId: "reg2", invoiceId: null, method: "balance", paid: 20000, balanceSource: "reg1" })
  })

  it("refuses an order whose commitment the code does not open", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: null, phase: "committed", createdAt: "2026-10-14T10:00:00Z", labelHash: built.request.labelHash, sealed: built.request.sealed, balanceSource: null, heldBy: null }] }
    answers["GET /api/registration/reg1"] = view({ ...built.request, commitment: `0x${"00".repeat(32)}` })
    await expect(flow.restore(OWNER_CODE)).rejects.toThrow("commitment")
    expect(store.orders()).toEqual([])
  })

  it("refuses a prepaid code", async () => {
    const { flow } = await modules()
    await expect(flow.restore("SN7-BJTBP-29596-R3HJ8-25YM7")).rejects.toThrow("not an owner code")
    expect(calls).toEqual([])
  })
})

describe("paidWith", () => {
  it("records an answered invoice's own method and its order's worth, a card's having no coin", async () => {
    const { flow } = await modules()
    expect(flow.paidWith({ invoiceId: "inv", amount: 20000, cryptoCurrency: "xmr", registration: { price: 20000 } } as never)).toEqual({ method: "xmr", paid: 20000 })
    expect(flow.paidWith({ invoiceId: "inv", amount: 10000, registration: { price: 10000 } } as never)).toEqual({ method: "card", paid: 10000 })
  })

  it("records the whole price of an order whose invoice is only the difference a balance left", async () => {
    const { flow } = await modules()
    expect(flow.paidWith({ invoiceId: "inv", amount: 30000, cryptoCurrency: "btc", registration: { price: 40000, fromBalance: 10000 } } as never)).toEqual({ method: "btc", paid: 40000 })
  })
})

// The spend vector the service's spendMessage test pastes: the fixture key, 21 October 2026 09:15 UTC, a sealed order
// whose IV is 12 zero bytes, and the service's fixture chain.
const SPEND = {
  registrationId: "t2Jk8RmQ4vXw9NcP3yLb6g",
  now: Date.UTC(2026, 9, 21, 9, 15),
  termStart: Date.UTC(2027, 0, 1) / 1000,
  chain: { resolver: "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6", sponsor: "0x9a676e781a523b5d0c0e43731313a708cb607508", chainId: 31337, tld: "simplex" },
  labelHash: "0x5bfbbf75311ec002834031d73fa30bfe8bdf675f4a3df72443841490c4b49d02",
  duration: 69259500,
  commitment: "0xbb87d2d7aa14251a04cdd68b5d878d0b4c44c6c76486d90a534dab9525105e33",
  sealed: "AAAAAAAAAAAAAAAACWgxqMk-UKfpra_bgbzR57AIDvSNmCR_G7IYbN7DX70sL2FVRHB1VfC0wdF-tc3ajHM3o8koM159Ja8hyg",
  sealedHash: "0x51431a705eb4903084cc8dbf3c1b966c9372914511c4623c889d49fdb8047da4",
  timestamp: 1792574100,
  digest: "0x72c2f4b7d84839fb97eb78668355a02fc0b18e211f264fca97d19a8f36decde3",
  signature: "0x8668cb4b72295479b4f9bcc2fd07fabfec2b4b8ae9230f2553536acb93c3e0cf6b2dad928a9a11b003c43ab43edeec117ce01c9214b8e99fe75fd547425e74481b",
}

describe("spendBalance", () => {
  const NO_LINKS = { contact: "", channel: "" }
  const quote = (price: number) => ({ ...QUOTE, ...SPEND.chain, price, termStart: SPEND.termStart })

  // the vector's clock and IV, for one test
  function fixedVector(): void {
    vi.useFakeTimers({ toFake: ["Date"], now: SPEND.now })
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => array)
  }
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function source(store: typeof import("../src/store.ts"), flow: typeof import("../src/flow.ts")) {
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: SPEND.registrationId, invoiceId: "inv0" })
    store.saveOrder(record)
    return record
  }

  it("signs the spend by the source's code over the new order's fields, sending no method when the balance covers the price", async () => {
    const { flow, store } = await modules()
    fixedVector()
    const record = await source(store, flow)
    answers[`POST /api/registration/${SPEND.registrationId}/spend`] = { registrationId: "reg2" }
    await flow.spendBalance(record, "another", NO_LINKS, quote(10000), 20000, "btc")
    const message = `simplex.domains spend ${SPEND.registrationId} ${SPEND.labelHash} 7 ${SPEND.duration} ${SPEND.commitment} ${SPEND.sealedHash} ${SPEND.timestamp}`
    expect(calls[0].body).toEqual({
      labelHash: SPEND.labelHash, length: 7, duration: SPEND.duration, commitment: SPEND.commitment, sealed: SPEND.sealed,
      price: 10000, balance: 20000, timestamp: SPEND.timestamp, signature: SPEND.signature,
    })
    expect(Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SPEND.sealed))).toString("hex")).toBe(SPEND.sealedHash.slice(2))
    expect(hashMessage(message)).toBe(SPEND.digest)
    expect(await recoverMessageAddress({ message, signature: SPEND.signature as Hex })).toBe(OWNER)
  })

  it("keeps a covered order under the source's code, sealed for it, paid by the balance, naming the order whose balance paid", async () => {
    const { flow, store } = await modules()
    const record = await source(store, flow)
    answers[`POST /api/registration/${SPEND.registrationId}/spend`] = { registrationId: "reg2" }
    const next = await flow.spendBalance(record, "another", LINKS, quote(10000), 10000, "card")
    expect(calls[0].body).not.toHaveProperty("method")
    expect(next).toMatchObject({ registrationId: "reg2", invoiceId: null, label: "another", ownerCode: OWNER_CODE, owner: OWNER, ...LINKS, method: "balance", paid: 10000, balanceSource: SPEND.registrationId })
    expect(store.orderByRegistration("reg2")).toEqual(next)
    expect(await unseal(WALLET.seed, (calls[0].body as { sealed: string }).sealed)).toEqual({ label: "another", ...LINKS })
  })

  it("sends the method for the difference, and keeps the order at its whole price with its invoice's method", async () => {
    const { flow, store } = await modules()
    const record = await source(store, flow)
    const answer = (request: { labelHash: string; duration: number; commitment: string; sealed: string }) => ({
      invoiceId: "inv2", status: "open", amount: 30000, currency: "usd", expiresAt: "2026-10-21T10:15:00Z", kind: "name", cryptoCurrency: "xmr", cryptoAmount: "1.875", address: "5x",
      registration: view(request, { id: "reg2", phase: "unpaid", price: 40000, fromBalance: 10000 }),
    })
    answers[`POST /api/registration/${SPEND.registrationId}/spend`] = () => answer(calls[0].body as never)
    const next = await flow.spendBalance(record, "another", NO_LINKS, quote(40000), 10000, "xmr")
    expect(calls[0].body).toMatchObject({ price: 40000, balance: 10000, method: "xmr" })
    expect(next).toMatchObject({ registrationId: "reg2", invoiceId: "inv2", method: "xmr", paid: 40000, balanceSource: SPEND.registrationId })
    expect(store.orderUrl(next)).toBe("/?order=inv2")
  })

  it("gives the caller the balance as it is now when it changed since the page read it", async () => {
    const { flow, store } = await modules()
    const api = await import("../src/api.ts")
    const record = await source(store, flow)
    const now = { amount: 5000, held: false, heldUntil: null, refunded: 5000 }
    answers[`POST /api/registration/${SPEND.registrationId}/spend`] = new Response(JSON.stringify({ error: "balance_changed", balance: now }), { status: 409 })
    const refused = await flow.spendBalance(record, "another", NO_LINKS, quote(10000), 10000, "btc").catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(api.BalanceChanged)
    expect(refused).toMatchObject({ code: "balance_changed", status: 409, balance: now })
    expect(store.orders().map((o) => o.registrationId)).toEqual([SPEND.registrationId])
  })

  it("sends a spend built once as the same body again after a lost answer, so the service takes it as an exact resend", async () => {
    const { flow, store } = await modules()
    const record = await source(store, flow)
    const spend = flow.spendDraft(record, "another", NO_LINKS, quote(10000))
    const built = await flow.spendRequest(record, spend, 10000, 20000, "btc")
    let sent = 0
    answers[`POST /api/registration/${SPEND.registrationId}/spend`] = () => ++sent === 1 ? new Response("", { status: 502 }) : { registrationId: "reg2" }
    await expect(flow.sendSpend(record, spend, built)).rejects.toMatchObject({ code: "network" })
    expect(store.orderByRegistration("reg2"), "nothing kept for an unanswered spend").toBeUndefined()
    const next = await flow.sendSpend(record, spend, built)
    expect(calls.map((c) => c.body)).toEqual([built.spend, built.spend])
    expect(next).toMatchObject({ registrationId: "reg2", request: built.request, method: "balance", balanceSource: SPEND.registrationId })
  })

  it("drafts the new order under the source's name code, which then owns the new name too", async () => {
    const { flow, store } = await modules()
    const record = await source(store, flow)
    expect(flow.spendDraft(record, "another", LINKS, quote(10000))).toEqual({ label: "another", links: LINKS, chain: SPEND.chain, years: 2, termStart: SPEND.termStart, ownerCode: OWNER_CODE })
  })
})

describe("balanceHolder", () => {
  const entry = (registrationId: string, request: { labelHash: string; sealed: string }, change: Record<string, unknown> = {}) =>
    ({ registrationId, invoiceId: null, phase: "unpaid", createdAt: "2026-10-14T10:00:00Z", labelHash: request.labelHash, sealed: request.sealed, balanceSource: null, heldBy: null, ...change })

  it("names the order find says holds the balance, never this browser's own order of that balance whose invoice closed", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const keep = (registrationId: string) => store.saveOrder({ ...flow.recordFor(draft(), built, "btc", 20000, { registrationId, invoiceId: `inv-${registrationId}` }), balanceSource: "src" })
    keep("expired")
    keep("holder")
    const source = { registrationId: "src", ownerCode: OWNER_CODE }
    answers["POST /api/registration/find"] = { registrations: [entry("holder", built.request, { balanceSource: "src" }), entry("expired", built.request, { balanceSource: "src" }), entry("src", built.request)] }
    expect(await flow.balanceHolder(source), "find names no holder").toBeNull()
    answers["POST /api/registration/find"] = { registrations: [entry("holder", built.request, { balanceSource: "src" }), entry("expired", built.request), entry("src", built.request, { heldBy: "holder" })] }
    expect((await flow.balanceHolder(source))?.registrationId).toBe("holder")
  })

  it("keeps a holder made in another browser, which find names, in this browser's records", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [entry("away", built.request, { balanceSource: "src" }), entry("src", built.request, { heldBy: "away" })] }
    answers["GET /api/registration/away"] = view(built.request, { id: "away", phase: "queued", fromBalance: 10000 })
    const holder = await flow.balanceHolder({ registrationId: "src", ownerCode: OWNER_CODE })
    expect(holder).toMatchObject({ registrationId: "away", balanceSource: "src", label: "dynamis" })
    expect(store.orderByRegistration("away")).toEqual(holder)
  })
})

describe("codeOrderOf and addOrder", () => {
  const found = (registrationId: string, phase: Phase, request: { labelHash: string; sealed: string }) =>
    ({ registrationId, invoiceId: null, phase, createdAt: "2026-10-14T10:00:00Z", labelHash: request.labelHash, sealed: request.sealed, balanceSource: null, heldBy: null })

  it("names the order the code restores, passing over an order whose sealed name is another's or does not open", async () => {
    const { flow, store } = await modules()
    const mine = (await flow.orderRequest(draft())).request
    const other = (await flow.orderRequest(draft("another"))).request
    answers["POST /api/registration/find"] = { registrations: [
      found("reg4", "unpaid", other), found("reg3", "committed", { labelHash: mine.labelHash, sealed: other.sealed }),
      found("reg2", "queued", { labelHash: mine.labelHash, sealed: "not-sealed" }), found("reg1", "taken", mine), found("reg0", "unpaid", mine),
    ] }
    const opened = await flow.codeOrderOf(OWNER_CODE.toLowerCase())
    expect([opened?.code, opened?.name, opened?.order.registrationId]).toEqual([OWNER_CODE, "dynamis", "reg1"])
    answers["GET /api/registration/reg1"] = view(mine, { id: "reg1", phase: "taken" })
    expect(await flow.addOrder(opened!)).toMatchObject({ registrationId: "reg1", label: "dynamis", ownerCode: OWNER_CODE })
    expect(store.orders().map((o) => o.registrationId)).toEqual(["reg1"])
  })

  it("finds no order when find lists only orders the code does not open", async () => {
    const { flow } = await modules()
    const other = (await flow.orderRequest({ ...draft(), ownerCode: formatOwnerCode(new Uint8Array(16).fill(7)) })).request
    answers["POST /api/registration/find"] = { registrations: [found("reg3", "committed", other)] }
    expect(await flow.codeOrderOf(OWNER_CODE)).toBeNull()
  })
})

describe("ownOrderFor", () => {
  const found = (registrationId: string, phase: string, labelHash: string, sealed: string) =>
    ({ registrationId, invoiceId: null, phase, createdAt: "2026-10-14T10:00:00Z", labelHash, sealed, balanceSource: null, heldBy: null })

  it("opens the code's order on its way for the name, passing over its other names and its finished orders", async () => {
    const { flow, store } = await modules()
    const mine = (await flow.orderRequest(draft())).request
    const other = (await flow.orderRequest(draft("another"))).request
    answers["POST /api/registration/find"] = { registrations: [
      found("reg3", "committed", other.labelHash, other.sealed), found("reg2", "taken", mine.labelHash, mine.sealed),
      found("reg1", "queued", mine.labelHash, mine.sealed), found("reg0", "unpaid", mine.labelHash, mine.sealed),
    ] }
    answers["GET /api/registration/reg1"] = view(mine, { id: "reg1", phase: "queued" })
    const record = await flow.ownOrderFor(OWNER_CODE, mine.labelHash)
    expect(record).toMatchObject({ registrationId: "reg1", label: "dynamis", ownerCode: OWNER_CODE })
    expect(store.orderByRegistration("reg1")?.label).toBe("dynamis")
  })

  it("finds nothing when the code has no order for the name", async () => {
    const { flow } = await modules()
    const other = (await flow.orderRequest(draft("another"))).request
    answers["POST /api/registration/find"] = { registrations: [found("reg3", "committed", other.labelHash, other.sealed)] }
    expect(await flow.ownOrderFor(OWNER_CODE, hex(labelHash("dynamis")))).toBeNull()
  })
})

describe("syncRecord", () => {
  it("reads an order moved to another name elsewhere back into the record", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    expect(await flow.syncRecord(record, view(built.request) as never)).toBe(record)
    const moved = await flow.orderRequest({ ...draft("another"), links: { contact: "", channel: "" } })
    const synced = await flow.syncRecord(record, view(moved.request) as never)
    expect(synced).toMatchObject({ label: "another", contact: "", channel: "", request: { commitment: moved.request.commitment } })
    expect(store.orderByRegistration("reg1")?.label).toBe("another")
  })

  it("gives up on an order the code does not open", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    expect(await flow.syncRecord(record, view({ ...built.request, commitment: `0x${"00".repeat(32)}` }) as never)).toBeNull()
    expect(store.orderByRegistration("reg1")?.request.commitment).toBe(built.request.commitment)
  })
})

describe("saveLinks", () => {
  it("sends one SetText per changed key, each with the next resolver nonce, signed by the name's key", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/name/records"] = { tx: "0xabc" }
    const saved: string[] = []
    const txs = await flow.saveLinks(record, CHAIN, 5, { contact: "", channel: "simplex:/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm" }, (kind) => saved.push(kind))
    expect(txs).toEqual(["0xabc", "0xabc"])
    expect(saved).toEqual(["contact", "channel"])
    const node = namehash("simplex", "dynamis")
    for (const [i, call] of calls.entries()) {
      const body = call.body as { key: string; value: string; nonce: number; deadline: number; signature: Hex }
      expect(body.nonce).toBe(5 + i)
      const digest = setTextDigest(31337n, fromHex(CHAIN.resolver), node, body.key, body.value, BigInt(body.nonce), BigInt(body.deadline))
      expect(await recoverAddress({ hash: hex(digest) as Hex, signature: body.signature })).toBe(OWNER)
    }
    expect(calls.map((c) => c.body.key)).toEqual([flow.KEYS.contact, flow.KEYS.channel])
  })
})

describe("saveLinks after a refusal", () => {
  it("reports only the keys saved before the refused one", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    let sent = 0
    answers["POST /api/name/records"] = () => (++sent === 1 ? { tx: "0x1" } : new Response(JSON.stringify({ error: "bad_request" }), { status: 400 }))
    const saved: string[] = []
    await expect(flow.saveLinks(record, CHAIN, 5, { contact: "", channel: "" }, (kind) => saved.push(kind))).rejects.toMatchObject({ code: "bad_request" })
    expect(saved).toEqual(["contact"])
  })
})

describe("store", () => {
  it("keeps orders newest first, updates by registration, and forgets everything", async () => {
    const { store } = await modules()
    const base = { invoiceId: null, label: "a", ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, tld: "simplex",
      request: { labelHash: "0x", length: 6, duration: 2 * YEAR_S, owner: OWNER, commitment: "0x", sealed: "sealed" } }
    expect(store.saveOrder({ ...base, registrationId: "old", createdAt: "2026-01-01T00:00:00Z" })).toBe(true)
    store.saveOrder({ ...base, registrationId: "new", createdAt: "2026-02-01T00:00:00Z" })
    store.updateOrder("old", { cancelled: true })
    expect(store.orders().map((o) => [o.registrationId, o.cancelled ?? false])).toEqual([["new", false], ["old", true]])
    store.forgetEverything()
    expect(store.orders()).toEqual([])
  })

  it("keeps a shown owner code until an order with that code is saved", async () => {
    const { flow, store } = await modules()
    store.addPending({ ownerCode: OWNER_CODE, label: "dynamis", tld: "simplex", createdAt: "2026-01-01T00:00:00Z" })
    store.addPending({ ownerCode: "SN-OTHER", label: "another", tld: "simplex", createdAt: "2026-01-01T00:00:00Z" })
    expect(store.pendingCodes().map((p) => p.label).sort()).toEqual(["another", "dynamis"])
    const built = await flow.orderRequest(draft())
    store.saveOrder(flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" }))
    expect(store.pendingCodes().map((p) => p.label)).toEqual(["another"])
    store.dropPending("SN-OTHER")
    expect(store.pendingCodes()).toEqual([])
  })

  it("keeps another tab's writes: every write starts from what storage holds now", async () => {
    const { store: tabA } = await modules()
    vi.resetModules()
    const tabB = await import("../src/store.ts")
    expect(tabA.orders()).toEqual([])
    const base = { invoiceId: null, label: "b", ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, tld: "simplex",
      request: { labelHash: "0x", length: 6, duration: 2 * YEAR_S, owner: OWNER, commitment: "0x", sealed: "sealed" } }
    tabB.saveOrder({ ...base, registrationId: "fromB", createdAt: "2026-01-01T00:00:00Z" })
    tabA.addCode({ code: "SN6-X", minLength: 6, years: 2, addedAt: "2026-01-01T00:00:00Z" })
    expect(tabB.orders().map((o) => o.registrationId)).toEqual(["fromB"])
    expect(tabB.codes().map((c) => c.code)).toEqual(["SN6-X"])
    tabA.saveOrder({ ...base, registrationId: "fromA", createdAt: "2026-02-01T00:00:00Z" })
    expect(tabB.orders().map((o) => o.registrationId)).toEqual(["fromA", "fromB"])
    tabB.forgetEverything()
    expect([tabA.orders(), tabA.codes()]).toEqual([[], []])
  })

  it("keeps serving what a full storage holds, moves new writes to memory, and forgets both", async () => {
    const { store } = await modules()
    const base = { invoiceId: null, label: "a", ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, tld: "simplex",
      request: { labelHash: "0x", length: 6, duration: 2 * YEAR_S, owner: OWNER, commitment: "0x", sealed: "sealed" } }
    store.saveOrder({ ...base, registrationId: "kept", createdAt: "2026-01-01T00:00:00Z" })
    const storage = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    const setItem = storage.setItem
    storage.setItem = () => { throw new DOMException("full", "QuotaExceededError") }
    expect(store.orders().map((o) => o.registrationId)).toEqual(["kept"])
    expect(store.canPersist()).toBe(false)
    expect(store.orders().map((o) => o.registrationId)).toEqual(["kept"])
    expect(store.saveOrder({ ...base, registrationId: "new", createdAt: "2026-02-01T00:00:00Z" })).toBe(false)
    expect(store.orders().map((o) => o.registrationId)).toEqual(["new", "kept"])
    store.forgetEverything()
    expect(store.orders()).toEqual([])
    storage.setItem = setItem
    expect(storage.length).toBe(0)
  })

  it("falls back to memory and says so when storage is refused", async () => {
    vi.stubGlobal("window", { get localStorage(): Storage { throw new Error("blocked") } })
    const { store } = await modules()
    expect(store.canPersist()).toBe(false)
    store.addCode({ code: "SN6-X", minLength: 6, years: 2, addedAt: "2026-01-01T00:00:00Z" })
    expect(store.codes()).toHaveLength(1)
  })
})
