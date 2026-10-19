import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CROSS_FAINT, CROSS_HELD, CROSS_IN, CROSS_MS, CROSS_OUT, pairingFor } from "../src/motion-values.ts"

const STYLES = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
const property = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(STYLES)?.[1].trim()

// The output of a CSS linear() easing at progress t, from its points; at a point given twice the later one holds.
function eased(easing: string, t: number): number {
  const points = /^linear\((.*)\)$/.exec(easing)![1].split(",").map((p, i, all) => {
    const [value, at] = p.trim().split(/\s+/)
    return { value: Number(value), at: at === undefined ? i / (all.length - 1) : parseFloat(at) / 100 }
  })
  const after = points.findIndex((p) => p.at > t)
  if (after < 0) return points.at(-1)!.value
  const [a, b] = [points[after - 1], points[after]]
  return a.value + (b.value - a.value) * (t - a.at) / (b.at - a.at)
}

describe("the crossing", () => {
  const STEPS = 1000
  const frames = Array.from({ length: STEPS + 1 }, (_, i) => i / STEPS).map((t) => ({ t, goes: 1 - eased(CROSS_OUT, t), comes: eased(CROSS_IN, t) }))

  it("starts with what goes whole and ends with what comes whole", () => {
    expect([frames[0].goes, frames[0].comes]).toEqual([1, 0])
    expect([frames[STEPS].goes, frames[STEPS].comes]).toEqual([0, 1])
  })

  it("never thins out: the two together are always at least HELD + FAINT", () => {
    const thin = frames.find((f) => f.goes + f.comes < CROSS_HELD + CROSS_FAINT - 1e-9)
    expect(thin, JSON.stringify(thin)).toBeUndefined()
  })

  it("never shows both clearly: the fainter is never more than FAINT", () => {
    const doubled = frames.find((f) => Math.min(f.goes, f.comes) > CROSS_FAINT + 1e-9)
    expect(doubled, JSON.stringify(doubled)).toBeUndefined()
  })

  it("is the stylesheet's crossing too", () => {
    expect([property("--cross-ms"), property("--cross-out"), property("--cross-in")]).toEqual([`${CROSS_MS}ms`, CROSS_OUT, CROSS_IN])
  })
})

describe("pairingFor", () => {
  const VIEWPORT = 800
  it("pairs everything when the window stays where it is, or moves by less than a pixel", () => {
    expect(pairingFor(null, 300, VIEWPORT)).toBe("all")
    expect(pairingFor(300, 300, VIEWPORT)).toBe("all")
    expect(pairingFor(300.5, 300, VIEWPORT)).toBe("all")
  })
  it("pairs only the order's card and name for a scroll up to a quarter of the window's height, either way", () => {
    expect(pairingFor(301, 300, VIEWPORT)).toBe("card")
    expect(pairingFor(0, 200, VIEWPORT)).toBe("card")
    expect(pairingFor(500, 300, VIEWPORT)).toBe("card")
  })
  it("pairs nothing past a quarter of the window's height", () => {
    expect(pairingFor(0, 201, VIEWPORT)).toBe("none")
    expect(pairingFor(1300, 300, VIEWPORT)).toBe("none")
  })
})
