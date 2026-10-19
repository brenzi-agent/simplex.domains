import { describe, expect, it } from "vitest"
import { routes, type View, viewOf } from "../src/screens/routes.ts"

const VIEWS: View[] = ["search", "checkout", "name-code", "order", "names", "restore", "edit", "trademarks"]

describe("viewOf", () => {
  const cases: [string, string, View][] = [
    ["?order=inv1", "/", "order"],
    ["?registration=reg1", "/names", "order"],
    ["", "/checkout", "checkout"],
    ["", "/checkout/code", "name-code"],
    ["", "/names", "names"],
    ["", "/restore", "restore"],
    ["", "/trademarks", "trademarks"],
    ["", "/edit/reg-1_a", "edit"],
    ["", "/", "search"],
    ["", "", "search"],
    ["", "/edit/", "search"],
    ["", "/unknown", "search"],
  ]
  for (const [query, path, view] of cases) {
    it(`reads ${view} from query "${query}" and path "${path}"`, () => {
      expect(viewOf(new URLSearchParams(query), path)).toBe(view)
    })
  }
})

describe("routes", () => {
  const backTo: Record<View, View[]> = {
    search: [],
    checkout: ["search"],
    "name-code": ["search", "checkout"],
    order: ["search", "checkout", "name-code"],
    names: ["search", "checkout", "name-code"],
    restore: ["search", "checkout", "name-code", "names"],
    edit: ["search", "checkout", "name-code", "names"],
    trademarks: ["search"],
  }
  for (const from of VIEWS) {
    it(`${from} goes back to ${backTo[from].join(", ") || "nothing"} and forward to the rest`, () => {
      const motions = Object.fromEntries(VIEWS.map((to) => [to, routes[from][to]]))
      const expected = Object.fromEntries(VIEWS.map((to) => [to, backTo[from].includes(to) ? "back" : "forward"]))
      expect(motions).toEqual(expected)
    })
  }

  it("goes back along the order the way it came forward", () => {
    const flow: View[] = ["search", "checkout", "name-code", "order"]
    flow.forEach((from, i) => flow.slice(i + 1).forEach((to) => {
      expect(routes[from][to], `${from} → ${to}`).toBe("forward")
      expect(routes[to][from], `${to} → ${from}`).toBe("back")
    }))
  })

  it("goes along the header's sections in their order", () => {
    for (const section of ["names", "restore", "edit"] as View[]) {
      expect(routes.search[section]).toBe("forward")
      expect(routes[section].search).toBe("back")
    }
  })
})
