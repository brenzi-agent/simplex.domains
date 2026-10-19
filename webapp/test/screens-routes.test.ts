import { describe, expect, it } from "vitest"
import { type CheckoutStep, checkoutStepOf, checkoutUrl, type View, viewOf } from "../src/screens/routes.ts"

describe("viewOf", () => {
  const cases: [string, string, View][] = [
    ["?order=inv1", "/", "order"],
    ["?registration=reg1", "/names", "order"],
    ["", "/checkout", "checkout"],
    ["", "/checkout/links", "checkout"],
    ["", "/checkout/code", "checkout"],
    ["", "/checkout/review", "search"],
    ["", "/checkout/", "search"],
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

describe("checkoutStepOf and checkoutUrl", () => {
  const steps: [string, CheckoutStep][] = [["/checkout/links", "links"], ["/checkout/code", "code"], ["/checkout", "review"]]
  for (const [path, step] of steps) {
    it(`reads the ${step} step from "${path}", and its link leads back to that path`, () => {
      expect(checkoutStepOf(path)).toBe(step)
      expect(checkoutUrl(step)).toBe(`/#${path}`)
    })
  }
})
