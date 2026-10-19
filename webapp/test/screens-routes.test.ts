import { describe, expect, it } from "vitest"
import { type View, viewOf } from "../src/screens/routes.ts"

describe("viewOf", () => {
  const cases: [string, string, View][] = [
    ["?order=inv1", "/", "order"],
    ["?registration=reg1", "/names", "order"],
    ["", "/checkout", "checkout"],
    ["", "/checkout/code", "search"],
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
