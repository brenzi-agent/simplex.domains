// The store API contract's acceptance cases (plans/names-codes/2026-10-21-store-api.md) that the mock can show, against
// the worker's mock directly. The page's own flows build and sign the requests.
import { expect, type APIRequestContext } from "@playwright/test"
import type { Hex } from "viem"
import type * as api from "../src/api.ts"
import { CHANNEL_KEY, CONTACT_KEY, labelHash, namehash, setTextDigest, YEAR_S } from "../src/crypto/registration.ts"
import { fromHex, hex, personalDigest, signDigest } from "../src/crypto/wallet.ts"
import * as flow from "../src/flow.ts"
import * as store from "../src/store.ts"
import { channelLink, contactLink, control, MOCK, oracleQuote, ownerSetsResolver, ownerSetsText, test, uniqueLabel } from "./helpers.ts"

type Json = Record<string, unknown>

// the flows' requests, made from this worker, go to its slot's mock
const ownFetch = globalThis.fetch
test.beforeAll(() => {
  globalThis.fetch = (input, init) => ownFetch(typeof input === "string" && input.startsWith("/") ? `${MOCK}${input}` : input, init)
})
test.afterAll(() => { globalThis.fetch = ownFetch })
// the cases speak to the service alone, so one browser's run of them is enough
test.skip(({ browserName }) => browserName !== "chromium", "API cases run once")

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await ownFetch(`${MOCK}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() as Json }
}

const TERM_START = Date.UTC(2027, 0, 1) / 1000
// the service's window for a signed timestamp, and how far an order's free days may be from its count
const SIGNED_WINDOW_S = 600
const TERM_SLACK_S = 3600
const PHASE_MS = 120_000
// a resolver that is not the store's, for a name pointed elsewhere
const ELSEWHERE: Hex = "0x000000000000000000000000000000000000dEaD"

type Quote = Extract<api.SearchAnswer, { status: "available" }>

async function quote(label: string): Promise<Quote> {
  const q = await flow.quoteOf(label)
  expect(q, `${label} is available`).not.toBeNull()
  return q!
}

async function draftOf(label: string, links = { contact: "", channel: "" }): Promise<flow.Draft> {
  const q = await quote(label)
  return { label, links, chain: flow.chainOf(q), years: q.years, termStart: q.termStart, ownerCode: flow.newOwnerCode() }
}

// the order signed again by its owner at another time
async function signedAt(ownerCode: string, request: api.SignedOrder, timestamp: number): Promise<api.SignedOrder> {
  const sealedHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.sealed))))
  const message = `simplex.domains order ${request.labelHash} ${request.length} ${request.duration} ${request.commitment} ${sealedHash} ${timestamp}`
  return { ...request, timestamp, signature: hex(signDigest(flow.walletOf(ownerCode)!.privateKey, personalDigest(message))) }
}

const invoiceBody = (request: api.SignedOrder, method: api.Method, price: number) => ({ kind: "name", ...request, method, price })

const viewOf = async (id: string, seenVersion?: number) =>
  (await call("GET", `/api/registration/${id}${seenVersion === undefined ? "" : `?seenVersion=${seenVersion}`}`)).json as unknown as api.RegistrationView

// the registration's view once its phase is one of these, followed by the version long poll
async function untilPhase(id: string, phases: api.Phase[]): Promise<api.RegistrationView> {
  const end = Date.now() + PHASE_MS
  let view = await viewOf(id)
  while (!phases.includes(view.phase)) {
    expect(Date.now(), `${id} reaches ${phases.join(" or ")}, at ${view.phase}`).toBeLessThan(end)
    view = await viewOf(id, view.version)
  }
  return view
}

async function codeOrder(request: APIRequestContext, label: string): Promise<{ draft: flow.Draft; built: flow.BuiltOrder; id: string; code: string }> {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const res = await call("POST", "/api/name/register", { ...built.request, code })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return { draft, built, id: res.json.registrationId as string, code }
}

// a committed view once its wait is over, with the sponsor's nonce read, as the page reveals it
async function untilRevealable(id: string): Promise<api.RegistrationView> {
  const view = await untilPhase(id, ["committed"])
  await new Promise((r) => setTimeout(r, Math.max(0, (view.revealAfter ?? 0) * 1000 - Date.now())))
  return viewOf(id)
}

// The order, as this worker's store keeps it, revealed with a register the service then fails: an order to try again or move.
async function failAtRegister(request: APIRequestContext, id: string): Promise<api.RegistrationView> {
  const view = await untilRevealable(id)
  await control(request, `fail/${id}`)
  await flow.revealOrder(view, store.orderByRegistration(id)!)
  return untilPhase(id, ["failed"])
}

async function failedOrder(request: APIRequestContext, label: string) {
  const order = await codeOrder(request, label)
  store.saveOrder(flow.recordFor(order.draft, order.built, "code", 0, { registrationId: order.id, invoiceId: null }))
  return { ...order, view: await failAtRegister(request, order.id) }
}

test("an order is answered again only for an exact resend, at any age of its signature; anything else meeting it is order_exists", async () => {
  const label = uniqueLabel("cx")
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const q = await quote(label)
  const first = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
  expect(first.status, JSON.stringify(first.json)).toBe(200)
  expect(first.json.amount, "the oracle's quote for the paid years").toBe(await oracleQuote(label, q.years))
  expect((await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))).json.invoiceId).toBe(first.json.invoiceId)
  // the same fields signed long after are the same order
  const late = await signedAt(draft.ownerCode, built.request, built.request.timestamp + 2 * SIGNED_WINDOW_S)
  expect((await call("POST", "/api/invoice", invoiceBody(late, "btc", q.price))).json.invoiceId).toBe(first.json.invoiceId)
  // sealed again, paid another way, or with other links, it says nothing of the order it met
  const others: [api.SignedOrder, api.Method][] = [
    [(await flow.orderRequest(draft)).request, "btc"], [built.request, "xmr"],
    [(await flow.orderRequest({ ...draft, links: { contact: contactLink("Cx"), channel: "" } })).request, "btc"],
  ]
  for (const [request, method] of others) {
    const met = await call("POST", "/api/invoice", invoiceBody(request, method, q.price))
    expect([met.status, met.json]).toEqual([409, { error: "order_exists" }])
  }
  // another wallet may order the same name
  const rival = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(label))).request, "btc", q.price))
  expect(rival.status).toBe(200)
  expect(rival.json.invoiceId).not.toBe(first.json.invoiceId)
})

test("an order refuses a wrong signer, a stale timestamp, free days off the term, a missing or oversized sealed, and a price the chain does not quote", async () => {
  const label = uniqueLabel("cr")
  const draft = await draftOf(label)
  const q = await quote(label)
  const { request } = await flow.orderRequest(draft)
  const stranger = flow.newOwnerCode()
  const off = (await flow.orderRequest({ ...draft, termStart: draft.termStart + TERM_SLACK_S + 100 })).request
  const refusals: [string, object, number, Json][] = [
    ["another key's signature", await signedAt(stranger, request, request.timestamp), 400, { error: "bad_request" }],
    ["a timestamp past the window", await signedAt(draft.ownerCode, request, request.timestamp - SIGNED_WINDOW_S - 100), 400, { error: "bad_request" }],
    ["free days more than an hour off", off, 400, { error: "bad_request" }],
    ["no sealed", { ...request, sealed: undefined }, 400, { error: "bad_request" }],
    ["a sealed over 11095 characters", { ...request, sealed: "a".repeat(11096) }, 400, { error: "bad_request" }],
    ["a name of 5 letters", { ...request, length: 5 }, 400, { error: "invalid_name" }],
  ]
  for (const [what, body, status, answer] of refusals) {
    const res = await call("POST", "/api/invoice", { kind: "name", ...body, method: "btc", price: q.price })
    expect([res.status, res.json], what).toEqual([status, answer])
  }
  const cheap = await call("POST", "/api/invoice", invoiceBody(request, "btc", q.price - 1))
  expect([cheap.status, cheap.json]).toEqual([409, { error: "catalog_changed", price: q.price }])
  // the free days are what is left until the term starts
  expect(Math.abs(request.duration - q.years * YEAR_S - (TERM_START - request.timestamp))).toBeLessThanOrEqual(1)
})

test("a cancelled or expired order gives way to a new one of the same wallet, and its exact resend answers it as it is now", async ({ request }) => {
  const label = uniqueLabel("cc")
  const draft = await draftOf(label)
  const q = await quote(label)
  const first = await flow.orderRequest(draft)
  const opened = await call("POST", "/api/invoice", invoiceBody(first.request, "btc", q.price))
  expect((await call("POST", `/api/invoice/${opened.json.invoiceId}/cancel`)).json.status).toBe("expired")
  const resent = await call("POST", "/api/invoice", invoiceBody(first.request, "btc", q.price))
  expect([resent.json.invoiceId, resent.json.status]).toEqual([opened.json.invoiceId, "expired"])
  const second = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "xmr", q.price))
  expect(second.status).toBe(200)
  await control(request, `expire/${second.json.invoiceId}`)
  // a payment reaching the closed invoice is late: the order stays unpaid
  await control(request, `settle/${second.json.invoiceId}`)
  const late = await call("GET", `/api/invoice/${second.json.invoiceId}`)
  expect([late.json.status, (late.json.registration as Json).phase]).toEqual(["paid", "unpaid"])
  expect((await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "card", q.price))).status).toBe(200)
})

// an invoice's status as the mock holds it, which a read of the invoice would mark expired once due
async function heldStatus(invoiceId: string): Promise<string> {
  const { invoices } = (await call("GET", "/control/state")).json as { invoices: { id: string; status: string }[] }
  return invoices.find((i) => i.id === invoiceId)!.status
}

test("an order past its invoice's expiry is closed by the next order of its wallet and name only while nothing has reached it", async ({ request }) => {
  const label = uniqueLabel("co")
  const draft = await draftOf(label)
  const q = await quote(label)
  const order = async (method: api.Method) => call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, method, q.price))
  const empty = await order("btc")
  await control(request, `overdue/${empty.json.invoiceId}`)
  expect(await heldStatus(empty.json.invoiceId as string), "not marked before an order meets it").toBe("open")
  const funded = await order("xmr")
  expect(funded.status, JSON.stringify(funded.json)).toBe(200)
  expect(await heldStatus(empty.json.invoiceId as string), "closed by the new order").toBe("expired")

  await control(request, `partial/${funded.json.invoiceId}`)
  await control(request, `overdue/${funded.json.invoiceId}`)
  expect(await order("btc"), "a paid order meeting the funded one").toEqual({ status: 409, json: { error: "order_exists" } })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const coded = await call("POST", "/api/name/register", { ...(await flow.orderRequest(draft)).request, code })
  expect(coded, "a code order meeting the funded one").toEqual({ status: 409, json: { error: "order_exists" } })
  const read = await call("GET", `/api/invoice/${funded.json.invoiceId}`)
  expect([read.json.status, read.json.cryptoAmountPaid], "a funded invoice past its expiry reads open").toEqual(["open", (Number(funded.json.cryptoAmount) / 2).toFixed(5)])
  expect(await call("POST", `/api/invoice/${funded.json.invoiceId}/cancel`)).toEqual({ status: 409, json: { error: "funded" } })
  await control(request, `settle/${funded.json.invoiceId}`)
  expect((await viewOf((funded.json.registration as Json).id as string)).phase, "settled into a registration").not.toBe("unpaid")
})

test("a code order closes an overdue invoice of its wallet and name with nothing received", async ({ request }) => {
  const label = uniqueLabel("cd")
  const draft = await draftOf(label)
  const paid = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "btc", (await quote(label)).price))
  await control(request, `overdue/${paid.json.invoiceId}`)
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const coded = await call("POST", "/api/name/register", { ...(await flow.orderRequest(draft)).request, code })
  expect(coded.status, JSON.stringify(coded.json)).toBe(200)
  expect(await heldStatus(paid.json.invoiceId as string)).toBe("expired")
})

test("search quotes the oracle with the term's start, and a registered name carries its grace period", async () => {
  const label = uniqueLabel("cq")
  const answer = await quote(label)
  expect([answer.price, answer.years, answer.termStart]).toEqual([await oracleQuote(label, 2), 2, TERM_START])
  for (const [length, cents] of [[6, 40000], [7, 20000], [12, 10000]]) {
    const res = await call("GET", `/api/name/${hex(labelHash("x".repeat(length)))}?length=${length}`)
    expect(res.json.price, `${length} letters`).toBe(cents)
  }
  const bakery = await call("GET", `/api/name/${hex(labelHash("bakery"))}?length=6`)
  expect([bakery.json.status, bakery.json.gracePeriod]).toEqual(["registered", 90 * 86400])
})

test("a code check answers every state, revoked included, an unknown code is code_invalid, and a body without a text code is bad_request", async ({ request }) => {
  for (const state of ["unused", "reserved", "used", "revoked", "expired", "unpaid"]) {
    const { code } = await control(request, "code", { minLength: 7, years: 3, state }) as { code: string }
    expect((await call("POST", "/api/code/check", { code })).json, state).toEqual({ minLength: 7, years: 3, state })
  }
  for (const code of ["SN7-BJTBP-29596-R3HJ8-25YM7", "SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G", "nonsense"]) {
    expect(await call("POST", "/api/code/check", { code }), code).toEqual({ status: 400, json: { error: "code_invalid" } })
  }
  for (const body of [{}, { code: null }, { code: 6 }, { code: ["SN7-BJTBP-29596-R3HJ8-25YM7"] }]) {
    expect(await call("POST", "/api/code/check", body), JSON.stringify(body)).toEqual({ status: 400, json: { error: "bad_request" } })
  }
})

test("a code order without a text code is bad_request, even for a name too short, and a text that is no issued code is code_invalid", async () => {
  const { request } = await flow.orderRequest(await draftOf(uniqueLabel("ck")))
  for (const code of [undefined, null, 6, ["SN7-BJTBP-29596-R3HJ8-25YM7"]]) {
    for (const length of [request.length, 5]) {
      const res = await call("POST", "/api/name/register", { ...request, length, code })
      expect(res, `code ${JSON.stringify(code)}, length ${length}`).toEqual({ status: 400, json: { error: "bad_request" } })
    }
  }
  for (const code of ["SN7-BJTBP-29596-R3HJ8-25YM7", "SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G", "nonsense", ""]) {
    expect(await call("POST", "/api/name/register", { ...request, code }), code).toEqual({ status: 400, json: { error: "code_invalid" } })
  }
})

test("find lists an owner's orders newest first, each with its label hash and sealed", async ({ request }) => {
  const { draft, built, id } = await codeOrder(request, uniqueLabel("cf"))
  const next = uniqueLabel("cf2")
  const later = (await flow.orderRequest({ ...draft, label: next })).request
  const second = await call("POST", "/api/invoice", invoiceBody(later, "btc", (await quote(next)).price))
  const wallet = flow.walletOf(draft.ownerCode)!
  const timestamp = Math.floor(Date.now() / 1000)
  const owner = built.owner.toLowerCase()
  const found = await call("POST", "/api/registration/find", { owner, timestamp, signature: hex(signDigest(wallet.privateKey, personalDigest(`simplex.domains find ${owner} ${timestamp}`))) })
  expect(found.json.registrations).toMatchObject([
    { invoiceId: second.json.invoiceId, phase: "unpaid", labelHash: later.labelHash, sealed: later.sealed },
    { registrationId: id, invoiceId: null, labelHash: built.request.labelHash, sealed: built.request.sealed },
  ])
  const stale = await call("POST", "/api/registration/find", { owner, timestamp: timestamp - 2 * SIGNED_WINDOW_S, signature: hex(signDigest(wallet.privateKey, personalDigest(`simplex.domains find ${owner} ${timestamp - 2 * SIGNED_WINDOW_S}`))) })
  expect(stale.status).toBe(400)
})

test("a held poll wakes on a new version, and of two retries at once one wins and the other is registration_changed with the view", async ({ request }) => {
  const { id, view } = await failedOrder(request, uniqueLabel("cv"))
  const held = viewOf(id, view.version)
  await control(request, "search", { writeDelayMs: 1500 })
  let answers: { status: number; json: Json }[]
  try {
    answers = await Promise.all([call("POST", `/api/registration/${id}/retry`), call("POST", `/api/registration/${id}/retry`)])
  } finally {
    await control(request, "search", { writeDelayMs: 0 })
  }
  expect(answers.map((a) => a.status).sort()).toEqual([200, 409])
  const lost = answers.find((a) => a.status === 409)!.json
  expect(lost.error).toBe("registration_changed")
  expect((lost.registration as Json).version).toBeGreaterThan(view.version)
  const woken = await held
  expect(woken.version).toBeGreaterThan(view.version)
})

test("another name or links: refused from an order with nothing to fix, a repeat changes nothing, a dearer name is price_too_high, and the fourth move is move_limit", async ({ request }) => {
  const label = uniqueLabel("cm")
  const q = await quote(label)
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const paid = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
  const id = (paid.json.registration as Json).id as string
  store.saveOrder(flow.recordFor(draft, built, "btc", q.price, { registrationId: id, invoiceId: paid.json.invoiceId as string }))
  await control(request, `settle/${paid.json.invoiceId}`)
  const move = async (to: string) => flow.retargetOrder(store.orderByRegistration(id)!, to, { contact: "", channel: "" }, await quote(to))
  await untilPhase(id, ["committed"])
  await expect(move(uniqueLabel("cm2")), "a committed order whose links were not refused").rejects.toMatchObject({ code: "bad_request" })
  // the service refuses the links at the reveal, which records the refusal and wakes the order's polls
  const before = await untilRevealable(id)
  await control(request, "search", { refuseLinks: true })
  await expect(flow.revealOrder(before, store.orderByRegistration(id)!)).rejects.toMatchObject({ code: "invalid_link" })
  expect((await viewOf(id)).version).toBeGreaterThan(before.version)
  const dearer = `q${Math.random().toString(36).slice(2, 7).padEnd(5, "q")}`
  await expect(move(dearer), "a 6-letter name dearer than the order").rejects.toMatchObject({ code: "price_too_high", body: { price: 40000 } })
  // the same name without links, then other names from failed orders: three moves in all
  let view = await move(label)
  expect([view.moves, view.phase, view.price]).toEqual([1, "queued", q.price])
  for (let n = 2; n <= 3; n++) {
    await failAtRegister(request, id)
    view = await move(uniqueLabel(`cm${n}`))
    expect(view.moves).toBe(n)
  }
  const repeat = await call("POST", `/api/registration/${id}/name`, await nameBody(store.orderByRegistration(id)!, view))
  expect([repeat.status, (repeat.json as unknown as api.RegistrationView).moves], "a repeat of the current fields").toEqual([200, 3])
  await failAtRegister(request, id)
  await expect(move(uniqueLabel("cm4"))).rejects.toMatchObject({ code: "move_limit", body: { registration: { id, moves: 3, phase: "failed" } } })
})

// the /name body of the registration's current fields, signed anew
async function nameBody(record: store.OrderRecord, view: api.RegistrationView): Promise<Json> {
  const timestamp = Math.floor(Date.now() / 1000)
  const sealedHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(view.sealed))))
  const length = record.label.length
  const message = `simplex.domains name ${view.id} ${view.labelHash} ${length} ${view.duration} ${view.commitment} ${sealedHash} ${timestamp}`
  return { labelHash: view.labelHash, length, duration: view.duration, commitment: view.commitment, sealed: view.sealed, timestamp,
    signature: hex(signDigest(flow.walletOf(record.ownerCode)!.privateKey, personalDigest(message))) }
}

// a name registered from a code order, without links, with what made it
async function registeredName(request: APIRequestContext, prefix: string) {
  const label = uniqueLabel(prefix)
  const { draft, built, id } = await codeOrder(request, label)
  await flow.revealOrder(await untilRevealable(id), flow.recordFor(draft, built, "code", 0, { registrationId: id, invoiceId: null }))
  await untilPhase(id, ["registered"])
  return { label, draft, labelHash: built.request.labelHash }
}

// a contact link edit of the name, signed by its key with the name's records nonce
async function contactEdit(name: Awaited<ReturnType<typeof registeredName>>, value: string, nonce?: number): Promise<Json> {
  const recordsNonce = nonce ?? (await call("GET", `/api/name/${name.labelHash}?length=${name.label.length}`)).json.recordsNonce as number
  const deadline = Math.floor(Date.now() / 1000) + 3600
  const digest = setTextDigest(BigInt(name.draft.chain.chainId), fromHex(name.draft.chain.resolver), namehash("simplex", name.label), CONTACT_KEY, value, BigInt(recordsNonce), BigInt(deadline))
  return { labelHash: name.labelHash, key: CONTACT_KEY, value, nonce: recordsNonce, deadline, signature: hex(signDigest(flow.walletOf(name.draft.ownerCode)!.privateKey, digest)) }
}

test("a link edit repeated after it was mined is answered from the edit, not checked anew", async ({ request }) => {
  const name = await registeredName(request, "ce")
  const edit = await contactEdit(name, contactLink("Ce"))
  const first = await call("POST", "/api/name/records", edit)
  expect(first.status, JSON.stringify(first.json)).toBe(200)
  expect(await call("POST", "/api/name/records", edit)).toEqual(first)
  // the same nonce with another value is checked anew, and its nonce has moved
  const other = await contactEdit(name, contactLink("Cf"), edit.nonce as number)
  expect(await call("POST", "/api/name/records", other)).toEqual({ status: 400, json: { error: "bad_request" } })
})

test("a link edit of a name pointed at another resolver is bad_request, and goes through once the name points back", async ({ request }) => {
  const name = await registeredName(request, "cg")
  const edit = await contactEdit(name, contactLink("Cg"))
  await ownerSetsResolver(name.draft.ownerCode, name.label, ELSEWHERE)
  expect(await call("POST", "/api/name/records", edit)).toEqual({ status: 400, json: { error: "bad_request" } })
  await ownerSetsResolver(name.draft.ownerCode, name.label, name.draft.chain.resolver as Hex)
  const sent = await call("POST", "/api/name/records", edit)
  expect(sent.status, JSON.stringify(sent.json)).toBe(200)
})

test("search splits a record set elsewhere on semicolons, trims each link, and answers the first five links of each key's kind", async ({ request }) => {
  const name = await registeredName(request, "cl")
  const contacts = ["L1", "L2", "L3", "L4", "L5", "L6"].map(contactLink)
  const contact = [`  ${contacts[0]}`, channelLink("Lx"), "not a link", "", ...contacts.slice(1)].join(" ; ")
  const channel = `${channelLink("K1")} ;${contactLink("K2")}; `
  await ownerSetsText(name.draft.ownerCode, name.label, CONTACT_KEY, contact)
  await ownerSetsText(name.draft.ownerCode, name.label, CHANNEL_KEY, channel)
  const answer = (await call("GET", `/api/name/${name.labelHash}?length=${name.label.length}`)).json
  expect(answer.records).toEqual({ contact, channel })
  expect((answer.entities as Json[]).map((e) => [e.type, e.link])).toEqual([...contacts.slice(0, 5).map((link) => ["address", link]), ["channel", channelLink("K1")]])
})
