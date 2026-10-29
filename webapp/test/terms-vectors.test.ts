// Contract Appendix C: the order, name and spend messages with `terms`, built from the contract's formats rather than
// src/flow.ts, so the page's builders are checked against these values and not the other way round. The builders then
// sign the same inputs, which only the same message bytes give the same signatures for.
import { hashMessage, recoverMessageAddress, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { formatOwnerCode } from "../src/crypto/code.ts"
import { commitmentSecret, labelHash, makeCommitment, YEAR_S } from "../src/crypto/registration.ts"
import { seal, unseal } from "../src/crypto/seal.ts"
import { checksumAddress, hex, personalDigest, signDigest, walletFromEntropy } from "../src/crypto/wallet.ts"

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"))
const ENTROPY = fromHex("6f2d1c9a4b7e3f80d15a2c6e9b04f7a3")
const WALLET = walletFromEntropy(ENTROPY)
const OWNER_CODE = "SN-DWPHS-6JBFR-ZR1MA-T5HQ9-P17QM-F5GM5"
const OWNER = "0x014f9c09CcEeDEF1B713110d04D3a07d5B5D9b73"

const LABEL = "alicebakery"
const DURATION = 69292800
const RESOLVER = "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6"
const REGISTRATION_ID = "t2Jk8RmQ4vXw9NcP3yLb6g"
const TIMESTAMP = 1792828800

const LABEL_HASH = "0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6"
const COMMITMENT = "0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5"
const SEALED = "AAAAAAAAAAAAAAAACWgxqMk-UKfpra_Zh6vc4KNBR6SX1WYpGb4COoWCCbM0bisYCH14WLzghp8hqi_-KyXSi4qf_DAdP_M4bFetD0s"
const SEALED_HASH = "0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2"

type Kind = "order" | "name" | "spend"
type Vector = { kind: Kind; terms: string; text: string; digest: Hex; signature: Hex }

const PLAIN = "213536f106608428de763fe26b1e9e31f27244152e9a853614ad73c67002ee6f"
const COMMUNITY = "community/3d2141022b4e322767cb6c8dcac2daf21b9d2c9a2b93af726099a8bd4cc15bff"

const VECTORS: Vector[] = [
  {
    kind: "order", terms: PLAIN,
    text: `simplex.domains order 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${PLAIN} 1792828800`,
    digest: "0x0ba979ab2c6935848734b7d7ff5fa66800b1bd6814e34ee0ad4f5d62d226401b",
    signature: "0xedd5071a12ad686a493bd8d9522cc95a292aea0e1970aaa3a4ea268696ed4f773b9dbfbf12d9aa79fd48bc1ea3825a720d8a09077bb4f35332480e1be1154fdf1c",
  },
  {
    kind: "order", terms: COMMUNITY,
    text: `simplex.domains order 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${COMMUNITY} 1792828800`,
    digest: "0x6d16887e061a31baedb6509fb0d01d7adc353c9496884b3af3d120b6aa850966",
    signature: "0x866ffd975972fe6a668eed758e8a69b57900d5e0898aa2872d344216fb5dd5ff45e380b07792c5b0220ad9564a24c3513ad1d39ac30ff888168bbd1c8e17aa011b",
  },
  {
    kind: "name", terms: PLAIN,
    text: `simplex.domains name t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${PLAIN} 1792828800`,
    digest: "0x1f5cb2957192c0189be04450d1c1a39330e3e485b7d55bf07cfd2ad517d473b3",
    signature: "0x8dbac86c2eb96cac72b0284c7221adf85816da3d9de83c1dc576f11531ba5d472dd6cd33d7ddaca7b3b8413746df8eda57eadfd29b14b52741a4079c0877a1061b",
  },
  {
    kind: "name", terms: COMMUNITY,
    text: `simplex.domains name t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${COMMUNITY} 1792828800`,
    digest: "0xbfe0f6e93445ebcee3b7c081c03c9cb6dcbeb9832b4917bd59ffbf3b87c94cc8",
    signature: "0xd989c2fe071690005e34c8a42cd61fc4be2c1b7899259c08210ecf234808ed792cfc8ac7071d994ab3029983294e2060c01bdd8608dd8b16ab98763f99927aa11c",
  },
  {
    kind: "spend", terms: PLAIN,
    text: `simplex.domains spend t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${PLAIN} 1792828800`,
    digest: "0x88a513cf0aaeaa0d9e3de39eb45e2d5cf5d99add5c8f11a0b96b7e1a6931eea4",
    signature: "0x888338b834c3f9f0eafb50366a0f436361fcb86813e8feda57501bfce6c00ace417a73b3956b6fbaebb29ee3983c6cdae52ba5dbff5b76d7bc7ed30c6006f1331b",
  },
  {
    kind: "spend", terms: COMMUNITY,
    text: `simplex.domains spend t2Jk8RmQ4vXw9NcP3yLb6g 0xbcc46b7948ff6be55bc3ff4db5bc4be16638f29e818a89244dae11caaed7c9c6 11 69292800 0x5e62a4cb7da596cb38169a6a552b5f69db2acee279b53be6693a78e03c3dfaa5 0x22709445157a2a1f7cb7e284e3ccf6c7ebc3b4d857002af452853c4a65907fe2 ${COMMUNITY} 1792828800`,
    digest: "0x971b7bde57f40f45c075c4f83b882fe61e792783fbec5916e216be966e026650",
    signature: "0x1bdb0d8d1f332cd8435d4d052f84060da55c8010a957e73fd38eb383925a5ba6606ebf04c09bce1697776670e4a7ad07d7cc2a18b4de3a7ea631e84f5cf77c6e1b",
  },
]

// The contract's formats: `simplex.domains order <labelHash> <length> <duration> <commitment> <sha256(sealed)> <terms> <timestamp>`,
// and for name and spend the registration id after the kind.
function messageText(kind: Kind, terms: string): string {
  const fields = `${LABEL_HASH} ${LABEL.length} ${DURATION} ${COMMITMENT} ${SEALED_HASH} ${terms} ${TIMESTAMP}`
  return kind === "order" ? `simplex.domains order ${fields}` : `simplex.domains ${kind} ${REGISTRATION_ID} ${fields}`
}

afterEach(() => vi.restoreAllMocks())

describe("Appendix C inputs", () => {
  it("derives the owner from the fixture owner code", () => {
    expect(formatOwnerCode(ENTROPY)).toBe(OWNER_CODE)
    expect(checksumAddress(WALLET.address)).toBe(OWNER)
  })

  it("hashes the label and builds the commitment with no links at the service's fixture resolver", () => {
    expect(hex(labelHash(LABEL))).toBe(LABEL_HASH)
    const commitment = makeCommitment({
      label: LABEL, tld: "simplex", owner: WALLET.address, duration: BigInt(DURATION), secret: commitmentSecret(WALLET.seed, LABEL),
      resolver: fromHex(RESOLVER), contactLinks: [], channelLinks: [],
    })
    expect(hex(commitment)).toBe(COMMITMENT)
  })

  it("seals the label with no links under a zero IV, and hashes the sealed text's ASCII bytes", async () => {
    // getRandomValues only fills the IV here, so returning the array untouched leaves it zero
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => array)
    expect(await seal(WALLET.seed, { label: LABEL, contact: "", channel: "" })).toBe(SEALED)
    expect(await unseal(WALLET.seed, SEALED)).toEqual({ label: LABEL, contact: "", channel: "" })
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SEALED))).toString("hex")
    expect(`0x${digest}`).toBe(SEALED_HASH)
  })
})

describe("Appendix C vectors", () => {
  const account = privateKeyToAccount(hex(WALLET.privateKey) as Hex)

  it.each(VECTORS)("$kind with terms $terms", async ({ kind, terms, text, digest, signature }) => {
    expect(messageText(kind, terms)).toBe(text)
    expect(hashMessage(text)).toBe(digest)
    expect(await account.signMessage({ message: text })).toBe(signature)
    expect(hex(signDigest(WALLET.privateKey, personalDigest(text)))).toBe(signature)
    expect(await recoverMessageAddress({ message: text, signature })).toBe(OWNER)
  })
})

describe("the page's builders reproduce Appendix C", () => {
  const YEARS = 2
  const CHAIN = { resolver: RESOLVER, sponsor: "0x9a676e781a523b5d0c0e43731313a708cb607508", chainId: 31337, tld: "simplex" }
  // the term's start that leaves the vector's free days at its timestamp
  const TERM_START = TIMESTAMP + DURATION - YEARS * YEAR_S
  const NO_LINKS = { contact: "", channel: "" }
  const vector = (kind: Kind, terms: string) => VECTORS.find((v) => v.kind === kind && v.terms === terms)!
  const TERMS = [...new Set(VECTORS.map((v) => v.terms))]
  let sent: Record<string, unknown>[]

  // the vector's clock and zero IV, storage for the order kept, and a service that answers a move with its view
  async function builders() {
    vi.useFakeTimers({ toFake: ["Date"], now: TIMESTAMP * 1000 })
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => array)
    const data = new Map<string, string>()
    vi.stubGlobal("window", { localStorage: {
      get length() { return data.size }, key: (i: number) => [...data.keys()][i] ?? null, getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k),
    } })
    sent = []
    vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      sent.push(body)
      return new Response(JSON.stringify({
        id: REGISTRATION_ID, version: 2, moves: 1, phase: "queued", label: null, owner: OWNER, years: YEARS, price: 10000, fromBalance: 0, balance: null, latePayment: null,
        commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, acceptance: null, unread: [], expiresAt: null, error: null, linksRefused: false,
        community: null, ...CHAIN, ...body,
      }), { status: 200 })
    })
    vi.resetModules()
    return { flow: await import("../src/flow.ts"), store: await import("../src/store.ts") }
  }
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const draft = (terms: string) => ({ label: LABEL, links: NO_LINKS, chain: CHAIN, years: YEARS, termStart: TERM_START, ownerCode: OWNER_CODE, terms })
  const quote = { status: "available" as const, price: 10000, currency: "usd", years: YEARS, termStart: TERM_START, community: null, terms: {
    hash: `0x${PLAIN}`,
    link: "https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/83649f66ffdf9a17fc881fbfadeb7e9aa33cdb4e/docs/terms.md#sha256=02936c81b34de0283128b131b687154eb3b4be7b08e9ee5697aab8b6344decf7",
  }, ...CHAIN }

  it.each(TERMS)("order with terms %s", async (terms) => {
    const { flow } = await builders()
    const { request } = await flow.orderRequest(draft(terms))
    expect(request).toEqual({ labelHash: LABEL_HASH, length: LABEL.length, duration: DURATION, owner: OWNER, commitment: COMMITMENT, sealed: SEALED, terms, timestamp: TIMESTAMP, signature: vector("order", terms).signature })
  })

  it.each(TERMS)("name with terms %s", async (terms) => {
    const { flow, store } = await builders()
    const built = await flow.orderRequest(draft(terms))
    const record = flow.recordFor(draft(terms), built, "btc", 10000, { registrationId: REGISTRATION_ID, invoiceId: "inv" })
    store.saveOrder(record)
    await flow.retargetOrder(record, LABEL, NO_LINKS, quote, terms)
    expect(sent[0]).toEqual({ labelHash: LABEL_HASH, length: LABEL.length, duration: DURATION, commitment: COMMITMENT, sealed: SEALED, terms, timestamp: TIMESTAMP, signature: vector("name", terms).signature })
  })

  it.each(TERMS)("spend with terms %s", async (terms) => {
    const { flow } = await builders()
    const source = { registrationId: REGISTRATION_ID, ownerCode: OWNER_CODE }
    const { spend } = await flow.spendRequest(source, flow.spendDraft(source, LABEL, NO_LINKS, quote, terms), 10000, 20000, "btc")
    expect(spend).toEqual({ labelHash: LABEL_HASH, length: LABEL.length, duration: DURATION, commitment: COMMITMENT, sealed: SEALED, price: 10000, balance: 20000, terms, timestamp: TIMESTAMP, signature: vector("spend", terms).signature })
  })
})
