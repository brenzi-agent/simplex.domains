import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, BalanceChanged, checkCode, findRegistrations, previewLink, readInvoice, readRegistration, retryDelay, searchName, seenOf, spend } from "../src/api.ts"

const HASH = "ab".repeat(32)

function answerWith(status: number, body: string, headers: Record<string, string> = {}): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers })))
}

async function errorOf(): Promise<ApiError> {
  const e = await searchName(HASH, 8).then(() => null, (e: unknown) => e)
  expect(e).toBeInstanceOf(ApiError)
  return e as ApiError
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("retryDelay", () => {
  const USUAL = 5000
  it("waits what the service asks, or the usual pause for a rate limit without a wait, a server failure or no answer", () => {
    expect(retryDelay(new ApiError("rate_limited", 429, 12, {}), USUAL)).toBe(12_000)
    expect(retryDelay(new ApiError("rate_limited", 429, null, {}), USUAL)).toBe(USUAL)
    expect(retryDelay(new ApiError("provider_unavailable", 503, null, {}), USUAL)).toBe(USUAL)
    expect(retryDelay(new ApiError("network", 0, null, {}), USUAL)).toBe(USUAL)
    expect(retryDelay(new TypeError("Failed to fetch"), USUAL)).toBe(USUAL)
  })
  it("gives up on a refusal that asking again cannot change", () => {
    expect(retryDelay(new ApiError("not_found", 404, null, {}), USUAL)).toBeNull()
    expect(retryDelay(new ApiError("bad_signature", 400, null, {}), USUAL)).toBeNull()
  })
})

describe("service errors", () => {
  it("reads the service's own error code, whatever the status", async () => {
    answerWith(503, JSON.stringify({ error: "provider_unavailable" }))
    const e = await errorOf()
    expect([e.code, e.status]).toEqual(["provider_unavailable", 503])
  })

  it("takes a proxy's gateway failure, with no code of the service's, as the network failing", async () => {
    for (const status of [502, 503, 504]) {
      answerWith(status, "<html><body>504 Gateway Time-out</body></html>", { "content-type": "text/html" })
      expect((await errorOf()).code, `status ${status}`).toBe("network")
    }
  })

  it("takes any other failure with no code as the service's own", async () => {
    answerWith(500, "")
    expect((await errorOf()).code).toBe("internal")
  })

  it("reads a proxy's rate limit and its wait, with no body", async () => {
    answerWith(429, "", { "retry-after": "12" })
    const e = await errorOf()
    expect([e.code, e.retryAfter]).toEqual(["rate_limited", 12])
  })

  it("takes a search answer the page cannot draw as no answer", async () => {
    const chain = { resolver: "0x1", sponsor: "0x2", chainId: 31337, tld: "simplex" }
    for (const body of [
      { status: "weird" }, { status: "registered", tld: "simplex" }, [], "registered",
      { status: "registered", tld: "simplex", entities: [{}] }, { status: "registered", tld: "simplex", entities: [null] },
      { status: "available", price: "100", years: 2, currency: "USD", ...chain }, { status: "available", price: 5, currency: "USD", ...chain },
    ]) {
      answerWith(200, JSON.stringify(body))
      expect((await errorOf()).code, JSON.stringify(body)).toBe("network")
    }
  })

  const PROFILE = { type: "channel", kind: "channel", displayName: "Alice", fullName: "Alice's news", image: null, subscribers: 12, profile: "ok" }

  it("passes a search answer the page can draw", async () => {
    const available = { status: "available", price: 10000, currency: "usd", years: 2, termStart: 1798761600, resolver: "0x1", sponsor: "0x2", chainId: 31337, tld: "simplex" }
    answerWith(200, JSON.stringify(available))
    expect(await searchName("ab".repeat(32), 8)).toEqual(available)
    const entity = { ...PROFILE, link: "https://simplex.chat/c#x", deepLink: "simplex:/c#x" }
    answerWith(200, JSON.stringify({ status: "registered", tld: "simplex", entities: [entity] }))
    expect(await searchName("ab".repeat(32), 8)).toMatchObject({ status: "registered", entities: [entity] })
  })

  it("takes a linked chat without its kind, full name or subscriber count, with a kind the app has not, or a kind its record cannot hold, as no answer", async () => {
    const link = { link: "https://simplex.chat/c#x", deepLink: "simplex:/c#x" }
    const changes = [{ kind: undefined }, { kind: "group" }, { fullName: undefined }, { subscribers: undefined }, { subscribers: -1 }, { subscribers: "many" },
      { type: "address" }, { kind: "contact" }, { profile: undefined }, { profile: "lost" }, { deepLink: undefined }, { deepLink: 5 }]
    for (const change of changes) {
      answerWith(200, JSON.stringify({ status: "registered", tld: "simplex", entities: [{ ...PROFILE, ...link, ...change }] }))
      expect((await errorOf()).code, JSON.stringify(change)).toBe("network")
    }
    // a link whose data the service did not read is still a chat, drawn without its profile
    for (const profile of ["unread", "unavailable"]) {
      const entity = { ...PROFILE, ...link, displayName: "", fullName: "", subscribers: null, profile }
      answerWith(200, JSON.stringify({ status: "registered", tld: "simplex", entities: [entity] }))
      expect(await searchName("ab".repeat(32), 8), profile).toMatchObject({ entities: [entity] })
    }
    // a link the chat core cannot parse has no deep link, and its own text is opened
    const unparsed = { ...PROFILE, ...link, deepLink: null, displayName: "", fullName: "", subscribers: null, profile: "unavailable" }
    answerWith(200, JSON.stringify({ status: "registered", tld: "simplex", entities: [unparsed] }))
    expect(await searchName("ab".repeat(32), 8)).toMatchObject({ entities: [unparsed] })
    for (const kind of ["contact", "business", "bot"]) {
      const entity = { ...PROFILE, ...link, type: "address", kind, subscribers: null }
      answerWith(200, JSON.stringify({ status: "registered", tld: "simplex", entities: [entity] }))
      expect(await searchName("ab".repeat(32), 8), kind).toMatchObject({ entities: [entity] })
    }
  })

  it("takes a code check the page cannot draw as no answer, and passes one it can", async () => {
    for (const body of [{}, [], { state: "weird", minLength: 6, years: 2 }, { minLength: "x", years: null, state: "unused" }]) {
      answerWith(200, JSON.stringify(body))
      const e = await checkCode("SN6-X").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(body)).toBe("network")
    }
    answerWith(200, JSON.stringify({ state: "unused", minLength: 6, years: 2 }))
    expect(await checkCode("SN6-X")).toEqual({ state: "unused", minLength: 6, years: 2 })
  })

  it("takes a success whose body was cut off as no answer", async () => {
    answerWith(200, '{"status":"avail')
    expect((await errorOf()).code).toBe("network")
  })

  const REGISTRATION = {
    id: "r1", version: 4, unread: [], moves: 0, phase: "unpaid", labelHash: `0x${"ab".repeat(32)}`, label: null, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", commitment: `0x${"cd".repeat(32)}`,
    sealed: "sealed", years: 2, duration: 2 * 365 * 86400, price: 10000, fromBalance: 0, balance: null, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, expiresAt: null, error: null, linksRefused: false, latePayment: null,
    resolver: "0x1", sponsor: "0x2", chainId: 31337, tld: "simplex",
  }
  const INVOICE = { invoiceId: "inv1", status: "open", amount: 10000, currency: "usd", expiresAt: "2026-10-16T12:00:00Z", kind: "name", registration: REGISTRATION, cryptoCurrency: "btc", cryptoAmount: "0.00156", address: "bc1q" }

  it("passes an invoice the page can draw, and takes one it cannot, or one that cannot be so, as no answer", async () => {
    answerWith(200, JSON.stringify(INVOICE))
    expect(await readInvoice("inv1")).toMatchObject({ invoiceId: "inv1", registration: { id: "r1" } })
    for (const body of [
      {}, { ...INVOICE, registration: undefined }, { ...INVOICE, registration: { ...REGISTRATION, phase: "lost" } }, { ...INVOICE, status: "weird" },
      { ...INVOICE, amount: "lots" }, { ...INVOICE, amount: -1 }, { ...INVOICE, cryptoAmount: "a lot" }, { ...INVOICE, registration: { ...REGISTRATION, years: 0 } },
      { ...INVOICE, registration: { ...REGISTRATION, version: "4" } }, { ...INVOICE, registration: { ...REGISTRATION, unread: undefined } },
      { ...INVOICE, registration: { ...REGISTRATION, unread: [4] } },
    ]) {
      answerWith(200, JSON.stringify(body))
      const e = await readInvoice("inv1").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(body).slice(0, 120)).toBe("network")
    }
  })

  const BALANCE = { amount: 10000, held: true, heldUntil: "2026-10-16T12:00:00Z", refunded: 2500 }

  it("passes what a late payment waits on", async () => {
    for (const waiting of ["confirming", "crediting", "support"]) {
      answerWith(200, JSON.stringify({ ...REGISTRATION, latePayment: { waiting } }))
      expect((await readRegistration("r1")).latePayment).toEqual({ waiting })
    }
  })

  it("passes find's paying order and holder of each order, and takes a malformed one as no answer", async () => {
    const entry = { registrationId: "r2", invoiceId: null, phase: "unpaid", createdAt: "2026-10-16T12:00:00Z", labelHash: "0x01", sealed: "s", balanceSource: "r1", heldBy: null }
    answerWith(200, JSON.stringify({ registrations: [entry] }))
    expect((await findRegistrations("0xowner", 1, "0x")).registrations).toEqual([entry])
    for (const change of [{ balanceSource: undefined }, { heldBy: 5 }]) {
      answerWith(200, JSON.stringify({ registrations: [{ ...entry, ...change }] }))
      const e = await findRegistrations("0xowner", 1, "0x").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(change)).toBe("network")
    }
  })

  it("passes an order's balance and what a balance paid of it, and takes either malformed as no answer", async () => {
    answerWith(200, JSON.stringify({ ...REGISTRATION, fromBalance: 4000, balance: BALANCE }))
    expect(await readRegistration("r1")).toMatchObject({ fromBalance: 4000, balance: BALANCE })
    for (const change of [
      { fromBalance: undefined }, { fromBalance: -1 }, { balance: undefined }, { balance: {} }, { balance: { ...BALANCE, amount: -5 } },
      { balance: { ...BALANCE, held: "yes" } }, { balance: { ...BALANCE, heldUntil: 5 } }, { balance: { ...BALANCE, refunded: null } },
      { linksRefused: undefined }, { linksRefused: "no" }, { latePayment: undefined }, { latePayment: {} }, { latePayment: { waiting: "later" } },
    ]) {
      answerWith(200, JSON.stringify({ ...REGISTRATION, ...change }))
      const e = await readRegistration("r1").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(change)).toBe("network")
    }
  })

  const SPEND = { labelHash: `0x${"ab".repeat(32)}`, length: 8, duration: 2 * 365 * 86400, commitment: `0x${"cd".repeat(32)}`, sealed: "sealed", price: 20000, balance: 10000, method: "btc" as const, timestamp: 1, signature: "0x" }

  it("posts a spend for the paying order and answers the new order, without an invoice or with the difference's", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ registrationId: "r2" }), { status: 200 }))
    vi.stubGlobal("fetch", fetched)
    expect(await spend("r/1", SPEND)).toEqual({ registrationId: "r2" })
    const [path, init] = fetched.mock.calls[0] as unknown as [string, RequestInit]
    expect([path, init.method, JSON.parse(String(init.body))]).toEqual(["/api/registration/r%2F1/spend", "POST", SPEND])
    const invoice = { ...INVOICE, amount: 10000, registration: { ...REGISTRATION, price: 20000, fromBalance: 10000 } }
    answerWith(200, JSON.stringify(invoice))
    expect(await spend("r1", SPEND)).toEqual(invoice)
    for (const body of [{}, { registrationId: 5 }, { ...invoice, registration: undefined }, { registrationId: "r2", invoiceId: "inv1" }]) {
      answerWith(200, JSON.stringify(body))
      const e = await spend("r1", SPEND).then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(body).slice(0, 80)).toBe("network")
    }
  })

  it("gives a refusal for a changed balance the balance as it is now, or null, and takes one it cannot read as no answer", async () => {
    for (const balance of [BALANCE, null]) {
      answerWith(409, JSON.stringify({ error: "balance_changed", balance }))
      const e = await spend("r1", SPEND).then(() => null, (e: unknown) => e)
      expect(e, JSON.stringify(balance)).toBeInstanceOf(BalanceChanged)
      expect(e).toMatchObject({ code: "balance_changed", status: 409, balance })
    }
    for (const body of [{ error: "balance_changed" }, { error: "balance_changed", balance: { amount: "lots" } }]) {
      answerWith(409, JSON.stringify(body))
      const e = await spend("r1", SPEND).then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(body)).toBe("network")
    }
    answerWith(409, JSON.stringify({ error: "order_exists" }))
    const other = await spend("r1", SPEND).then(() => null, (e: unknown) => e)
    expect(other).not.toBeInstanceOf(BalanceChanged)
    expect((other as ApiError).code).toBe("order_exists")
  })

  it("holds a poll on the registration's version and the payment marks it has seen", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify(INVOICE), { status: 200 }))
    vi.stubGlobal("fetch", fetched)
    const invoice = await readInvoice("inv1")
    await readInvoice("inv1", seenOf({ ...invoice, cryptoAmountPaid: "0.5", paidInFull: true }))
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(REGISTRATION), { status: 200 })))
    await readRegistration("r1", 4)
    await readRegistration("r1", 0)
    const urls = [...fetched.mock.calls, ...(fetch as unknown as typeof fetched).mock.calls].map((c) => (c as unknown as [string])[0])
    expect(urls).toEqual(["/api/invoice/inv1", "/api/invoice/inv1?wait=open&seenVersion=4&seenPaid=0.5&seenFull=1", "/api/registration/r1?seenVersion=4", "/api/registration/r1?seenVersion=0"])
  })

  it("takes a link preview whose image is no image the page can show as no answer", async () => {
    answerWith(200, JSON.stringify({ ...PROFILE, image: "data:image/png;base64,iVBORw0KGgo=" }))
    expect(await previewLink("x")).toMatchObject({ displayName: "Alice" })
    for (const image of ["javascript:alert(1)", "http://example.com/a.png", "https://example.com/a.png", 5]) {
      answerWith(200, JSON.stringify({ ...PROFILE, image }))
      const e = await previewLink("x").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, String(image)).toBe("network")
    }
  })

  it("takes a search or code answer with values that cannot be so as no answer", async () => {
    const chain = { resolver: "0x1", sponsor: "0x2", chainId: 31337, tld: "simplex" }
    for (const body of [
      { status: "available", price: -500, years: 2, termStart: 1798761600, currency: "usd", ...chain }, { status: "available", price: 500, years: 0, termStart: 1798761600, currency: "usd", ...chain },
      { status: "available", price: 500, years: 2, currency: "usd", ...chain }, { status: "available", price: 500, years: 2, termStart: "2027", currency: "usd", ...chain },
      { status: "registered", tld: "simplex", entities: [], owner: 5 }, { status: "registered", tld: "simplex", entities: [], records: { contact: 1 } },
    ]) {
      answerWith(200, JSON.stringify(body))
      expect((await errorOf()).code, JSON.stringify(body)).toBe("network")
    }
    answerWith(200, JSON.stringify({ state: "unused", minLength: -3, years: -1 }))
    expect(((await checkCode("SN6-X").then(() => null, (e: unknown) => e)) as ApiError).code).toBe("network")
  })
})
