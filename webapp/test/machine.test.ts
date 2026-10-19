import { describe, expect, it, vi } from "vitest"
import { type Machine, step } from "../src/screens/machine.ts"

type S = { n: number }
type E = { kind: "add"; by: number }
type K = "low" | "high" | "odd"
const machine: Machine<S, E, K> = {
  name: "test",
  reduce: (s, e) => ({ n: s.n + e.by }),
  screenOf: (s) => (s.n % 2 ? "odd" : s.n < 10 ? "low" : "high"),
  moves: { low: { high: "forward" }, high: { low: "back" }, odd: {} },
}

describe("step", () => {
  it("draws the first screen as a page change", () => {
    expect(step(machine, { n: 0 }, null, { kind: "add", by: 2 }, vi.fn())).toEqual({ state: { n: 2 }, screen: "low", motion: "screen", expected: true })
  })
  it("keeps a screen of the same kind in place", () => {
    expect(step(machine, { n: 2 }, "low", { kind: "add", by: 2 }, vi.fn()).motion).toBe("in-place")
  })
  it("takes a listed move's motion", () => {
    expect(step(machine, { n: 8 }, "low", { kind: "add", by: 2 }, vi.fn())).toMatchObject({ screen: "high", motion: "forward", expected: true })
  })
  it("logs a move missing from the table and still shows it as a page change", () => {
    const warn = vi.fn()
    expect(step(machine, { n: 2 }, "low", { kind: "add", by: 1 }, warn)).toMatchObject({ screen: "odd", motion: "screen", expected: false })
    expect(warn).toHaveBeenCalledWith("[screens] test: unexpected move low → odd")
  })
})
