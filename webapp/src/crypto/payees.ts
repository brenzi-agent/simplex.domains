import { ed25519 } from "@noble/curves/ed25519"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToNumberLE, equalBytes } from "@noble/curves/utils"
import { ripemd160 } from "@noble/hashes/legacy"
import { sha256 } from "@noble/hashes/sha2"
import { keccak_256 } from "@noble/hashes/sha3"
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils"
import { base58xmr, bech32, bech32m, createBase58check } from "@scure/base"

const SCALAR = /^[0-9a-f]{64}$/
const WITNESS_V0 = 0
const MAX_WITNESS_VERSION = 16
const WITNESS_V0_PROGRAM_BYTES = [20, 32]
const MIN_PROGRAM_BYTES = 2
const MAX_PROGRAM_BYTES = 40
const HASH160_BYTES = 20
const LEGACY_VERSIONS: Record<string, number[]> = { bc: [0x00, 0x05], tb: [0x6f, 0xc4], bcrt: [0x6f, 0xc4] }
const MONERO_STANDARD_PREFIX: Record<number, number> = { 42: 18, 36: 24, 63: 53 }
const base58check = createBase58check(sha256)
const KEY_BYTES = 32
const CHECKSUM_BYTES = 4
const MONERO_ADDRESS_BYTES = 1 + 2 * KEY_BYTES + CHECKSUM_BYTES
const VIEW_PROOF = utf8ToBytes("simplex.domains view proof")
const L = ed25519.Point.Fn.ORDER
const G = ed25519.Point.BASE

export interface ViewProof { challenge: string; response: string }

export const p2wpkh = (hrp: string, publicKey: Uint8Array) => bech32.encode(hrp, [WITNESS_V0, ...bech32.toWords(ripemd160(sha256(publicKey)))])

export function bitcoinProven(address: string, keyTweak: string, receiveKeys: string[], hrp: string): boolean {
  if (!SCALAR.test(keyTweak)) return false
  const t = BigInt(`0x${keyTweak}`)
  if (t === 0n || t >= secp256k1.Point.Fn.ORDER) return false
  const tweak = secp256k1.Point.BASE.multiply(t)
  return receiveKeys.some((key) => {
    const derived = secp256k1.Point.fromHex(key.slice(2)).add(tweak)
    return !derived.is0() && p2wpkh(hrp, derived.toBytes(true)) === address
  })
}

function segwitAddress(address: string, hrp: string): boolean {
  const v0 = bech32.decodeUnsafe(address)
  const decoded = v0 ?? bech32m.decodeUnsafe(address)
  if (!decoded || decoded.prefix !== hrp) return false
  const [version, ...words] = decoded.words
  const program = bech32.fromWordsUnsafe(words)
  if (!program) return false
  return v0 ? version === WITNESS_V0 && WITNESS_V0_PROGRAM_BYTES.includes(program.length)
    : version > WITNESS_V0 && version <= MAX_WITNESS_VERSION && program.length >= MIN_PROGRAM_BYTES && program.length <= MAX_PROGRAM_BYTES
}

function legacyAddress(address: string, hrp: string): boolean {
  try {
    const payload = base58check.decode(address)
    return payload.length === 1 + HASH160_BYTES && (LEGACY_VERSIONS[hrp] ?? []).includes(payload[0])
  } catch {
    return false
  }
}

export const bitcoinAddress = (address: string, hrp: string) => segwitAddress(address, hrp) || legacyAddress(address, hrp)

export const hashToScalar =(...parts: Uint8Array[]) => bytesToNumberLE(keccak_256(concatBytes(...parts))) % L

const scalarOf = (hex: string) => {
  if (!SCALAR.test(hex)) return null
  const value = bytesToNumberLE(hexToBytes(hex))
  return value < L ? value : null
}

const pointOf = (bytes: Uint8Array) => {
  try {
    return ed25519.Point.fromBytes(bytes)
  } catch {
    return null
  }
}

export function moneroKeys(address: string): { prefix: number; spend: Uint8Array; view: Uint8Array } | null {
  let bytes: Uint8Array
  try {
    bytes = base58xmr.decode(address)
  } catch {
    return null
  }
  if (bytes.length !== MONERO_ADDRESS_BYTES) return null
  const body = bytes.slice(0, -CHECKSUM_BYTES)
  if (!equalBytes(keccak_256(body).slice(0, CHECKSUM_BYTES), bytes.slice(-CHECKSUM_BYTES))) return null
  return { prefix: bytes[0], spend: body.slice(1, 1 + KEY_BYTES), view: body.slice(1 + KEY_BYTES) }
}

export function moneroAddress(address: string, subaddressPrefix: number): boolean {
  const prefix = moneroKeys(address)?.prefix
  return prefix !== undefined && (prefix === subaddressPrefix || prefix === MONERO_STANDARD_PREFIX[subaddressPrefix])
}

export function moneroProven(address: string, spendTweak: string, viewProof: ViewProof, primaryAddresses: string[], subaddressPrefix: number): boolean {
  const sub = moneroKeys(address)
  const [m, c, s] = [scalarOf(spendTweak), scalarOf(viewProof.challenge), scalarOf(viewProof.response)]
  if (sub === null || sub.prefix !== subaddressPrefix || m === null || c === null || s === null) return false
  const [D, C] = [pointOf(sub.spend), pointOf(sub.view)]
  if (D === null || C === null || C.is0() || !C.isTorsionFree()) return false
  return primaryAddresses.some((primary) => {
    const keys = moneroKeys(primary)!
    const [B, A] = [ed25519.Point.fromBytes(keys.spend), ed25519.Point.fromBytes(keys.view)]
    if (!B.add(G.multiplyUnsafe(m)).equals(D)) return false
    const R1 = G.multiplyUnsafe(s).add(A.multiplyUnsafe(c))
    const R2 = D.multiplyUnsafe(s).add(C.multiplyUnsafe(c))
    return hashToScalar(VIEW_PROOF, A.toBytes(), D.toBytes(), C.toBytes(), R1.toBytes(), R2.toBytes()) === c
  })
}
