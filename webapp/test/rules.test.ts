import { describe, expect, it } from "vitest"
import { clock, dateOf, dollars, freeDays, letters, methodName, seconds, shortAddress, termEnd } from "../src/format.ts"
import { foldLabel, labelProblem, linkKind, linkProblem, LINK_MAX_BYTES, linkTooLong } from "../src/names.ts"

describe("label rules", () => {
  it("folds case and spaces, and accepts 6 to 63 letters with single inner hyphens", () => {
    expect(foldLabel("  Bakery ")).toBe("bakery")
    expect(foldLabel("Bakery.SimpleX")).toBe("bakery")
    expect(foldLabel("bak\u200Bery\uFEFF")).toBe("bakery")
    expect(labelProblem(foldLabel("bak.ery"))).toBe("chars")
    expect(labelProblem("bakery")).toBeNull()
    expect(labelProblem("bak-ery-2")).toBeNull()
    expect(labelProblem("a".repeat(63))).toBeNull()
  })

  it("names each problem", () => {
    expect(labelProblem("abcde")).toBe("short")
    expect(labelProblem("a".repeat(64))).toBe("long")
    expect(labelProblem("-bakery")).toBe("chars")
    expect(labelProblem("bakery-")).toBe("chars")
    expect(labelProblem("bak--ery")).toBe("chars")
    expect(labelProblem("bäkery")).toBe("chars")
    expect(labelProblem("Bakery")).toBe("chars")
  })
})

describe("link rules", () => {
  const contact = "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS"
  const channel = "simplex:/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm?v=1"

  it("accepts one short link of the field's kind", () => {
    expect(linkProblem("contact", contact)).toBeNull()
    expect(linkProblem("channel", channel)).toBeNull()
    expect(linkKind(contact)).toBe("contact")
    expect(linkKind(channel)).toBe("channel")
  })

  it("refuses the other kind, full links, two links and oversized links", () => {
    expect(linkProblem("channel", contact)).toBe("kind")
    expect(linkProblem("contact", "https://simplex.chat/contact#/?v=2&smp=smp%3A%2F%2Fabc")).toBe("kind")
    expect(linkProblem("contact", `${contact};${contact}`)).toBe("kind")
    expect(linkProblem("contact", `${contact}?x=${"a".repeat(LINK_MAX_BYTES)}`)).toBe("long")
    expect(linkKind("hello")).toBeNull()
  })

  it("tells a link too long by its bytes, whatever its kind, so a link of no kind can be refused for its length", () => {
    const long = `${contact}?x=${"a".repeat(LINK_MAX_BYTES)}`
    expect(linkKind(long)).toBeNull()
    expect(linkTooLong(long)).toBe(true)
    expect(linkTooLong(`${contact}?x=${"\u00e9".repeat(LINK_MAX_BYTES / 2)}`), "two bytes a letter").toBe(true)
    expect(linkTooLong(contact)).toBe(false)
  })
})

describe("formatting", () => {
  it("writes cents as dollars, with cents only where an amount has them", () => {
    expect(dollars(40000)).toBe("$400")
    expect(dollars(10050)).toBe("$100.50")
    expect(dollars(10005)).toBe("$100.05")
    expect(dollars(123456700)).toBe("$1,234,567")
  })

  it("shortens an address and writes a UTC date", () => {
    expect(shortAddress("0x014f9c09CcEeDEF1B713110d04D3a07d5B5D9b73")).toBe("0x014f\u2060…\u20609b73")
    expect([letters(1), letters(7)]).toEqual(["1 letter", "7 letters"])
    expect(dateOf(Date.UTC(2028, 10, 12) / 1000)).toBe("12\u00a0November 2028")
  })

  const TERM_START = Date.UTC(2027, 0, 1) / 1000

  it("counts the free days to the term's start, a part day as a whole one, and none once it has started", () => {
    const day = 86400
    expect(freeDays(TERM_START, Date.UTC(2026, 9, 21) / 1000)).toBe(72)
    expect(freeDays(TERM_START, TERM_START - day / 2)).toBe(1)
    expect([freeDays(TERM_START, TERM_START), freeDays(TERM_START, TERM_START + 5 * day)]).toEqual([0, 0])
  })

  it("ends a term its years of 365 days after its start, or after now once the start has passed", () => {
    expect(termEnd(2, TERM_START, Date.UTC(2026, 9, 21) / 1000)).toBe(1861833600)
    expect(dateOf(termEnd(2, TERM_START, Date.UTC(2026, 9, 21) / 1000))).toBe("31\u00a0December 2028")
    expect(dateOf(termEnd(5, TERM_START, Date.UTC(2026, 9, 21) / 1000))).toBe("31\u00a0December 2031")
    expect(dateOf(termEnd(2, TERM_START, Date.UTC(2027, 5, 15) / 1000))).toBe("14\u00a0June 2029")
  })

  it("writes seconds in the singular and the plural", () => {
    expect(seconds(1)).toBe("1 second")
    expect(seconds(30)).toBe("30 seconds")
  })

  it("writes a countdown that never goes negative, and method names", () => {
    expect(clock(65.9)).toBe("1:05")
    expect(clock(-3)).toBe("0:00")
    expect(methodName("xmr")).toBe("Monero")
    expect(methodName("code")).toBe("Code")
  })
})
