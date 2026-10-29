import { describe, expect, it } from "vitest"
import { askFor, termsToSign, ticked } from "../src/screens/terms.ts"

const TERMS = { version: "2026-10-23", url: "https://simplex.chat/" }
const NEWER = { version: "2026-11-01", url: "https://simplex.chat/" }
const BAKERS = { for: "bakers and pastry chefs", years: 2, terms: { url: "https://simplex.chat/community-terms", hash: `0x${"c7".repeat(32)}` } }
const SIGNED = `2026-10-23/community/${"c7".repeat(32)}`
const NEWER_SIGNED = `2026-11-01/community/${"c7".repeat(32)}`

describe("termsToSign", () => {
  it("signs a name again with the terms its order signed while they are the name's now, asking nothing", () => {
    expect(termsToSign("alice1", "2026-10-23", "2026-10-23", null)).toBe("2026-10-23")
    expect(termsToSign("alice1", SIGNED, SIGNED, null)).toBe(SIGNED)
  })

  it("asks first when the order signed an older version, the plain terms of a name now on the community list, or none", () => {
    expect(termsToSign("alice1", "2026-11-01", "2026-10-23", null)).toBeNull()
    expect(termsToSign("alice1", SIGNED, "2026-10-23", null)).toBeNull()
    expect(termsToSign("alice1", "2026-10-23", SIGNED, null)).toBeNull()
    expect(termsToSign("alice1", SIGNED, `2026-10-23/community/${"d8".repeat(32)}`, null), "other community terms").toBeNull()
    expect(termsToSign("alice1", "2026-10-23", null, null)).toBeNull()
    expect(termsToSign("alice1", "2026-10-23", undefined, null)).toBeNull()
  })

  it("signs the terms the buyer just ticked while they are the name's now", () => {
    expect(termsToSign("alice1", "2026-11-01", "2026-10-23", { ...askFor("alice1", NEWER, null, false), agreed: true })).toBe("2026-11-01")
    expect(termsToSign("alice1", NEWER_SIGNED, null, { ...askFor("alice1", NEWER, BAKERS, true), agreed: true, accepted: true })).toBe(NEWER_SIGNED)
  })

  it("asks again for a community name until its own box is ticked too", () => {
    expect(termsToSign("alice1", NEWER_SIGNED, null, { ...askFor("alice1", NEWER, BAKERS, true), agreed: true })).toBeNull()
    expect(termsToSign("alice1", NEWER_SIGNED, null, { ...askFor("alice1", NEWER, BAKERS, true), accepted: true })).toBeNull()
  })

  it("asks again for another name than the one the buyer ticked the terms for", () => {
    expect(termsToSign("bob123", "2026-11-01", "2026-10-23", { ...askFor("alice1", NEWER, null, false), agreed: true })).toBeNull()
  })

  it("asks again when the buyer has not ticked, or ticked terms that are no longer the name's", () => {
    expect(termsToSign("alice1", "2026-11-01", "2026-10-23", askFor("alice1", NEWER, null, false))).toBeNull()
    expect(termsToSign("alice1", "2026-11-01", "2026-10-23", { ...askFor("alice1", TERMS, null, false), agreed: true })).toBeNull()
    expect(termsToSign("alice1", NEWER_SIGNED, "2026-10-23", { ...askFor("alice1", NEWER, null, false), agreed: true })).toBeNull()
  })
})

describe("askFor", () => {
  it("asks for the terms and the community entry unticked, saying whether they changed since the page showed them", () => {
    expect(askFor("alice1", NEWER, BAKERS, true)).toEqual({ label: "alice1", terms: NEWER, community: BAKERS, agreed: false, accepted: false, changed: true })
    expect(askFor("alice1", TERMS, null, false)).toEqual({ label: "alice1", terms: TERMS, community: null, agreed: false, accepted: false, changed: false })
  })
})

describe("ticked", () => {
  it("is the name terms' box ticked, and a community name's own box", () => {
    expect(ticked({ agreed: true, accepted: false, community: null })).toBe(true)
    expect(ticked({ agreed: false, accepted: true, community: null })).toBe(false)
    expect(ticked({ agreed: true, accepted: true, community: BAKERS })).toBe(true)
    expect(ticked({ agreed: true, accepted: false, community: BAKERS })).toBe(false)
    expect(ticked({ agreed: false, accepted: true, community: BAKERS })).toBe(false)
  })
})
