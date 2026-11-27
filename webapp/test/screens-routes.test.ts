import { describe, expect, it } from "vitest"
import { type CheckoutStep, checkoutStepOf, checkoutUrl, CODE_FROM_ORDER_URL, CODE_URL, EDIT_PATH, editUrl, fromOrder, orderLinkOf, type View, viewOf } from "../src/screens/routes.ts"

describe("viewOf", () => {
  const cases: [string, string, View][] = [
    ["?o=Hd1_x-K2", "/", "order"],
    ["?order=inv1", "/", "order"],
    ["?registration=reg1", "/names", "order"],
    ["", "/checkout", "checkout"],
    ["", "/checkout/links", "checkout"],
    ["", "/checkout/code", "checkout"],
    ["", "/checkout/review", "search"],
    ["", "/checkout/", "search"],
    ["", "/names", "names"],
    ["", "/restore", "search"],
    ["", "/trademarks", "trademarks"],
    ["", "/code", "code"],
    ["", "/code/x", "search"],
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

describe("orderLinkOf", () => {
  it("reads an order's handle, or an older link's invoice or registration, the handle first", () => {
    expect(orderLinkOf(new URLSearchParams("o=Hd1&order=inv1"))).toEqual({ handle: "Hd1" })
    expect(orderLinkOf(new URLSearchParams("order=inv1&registration=reg1"))).toEqual({ invoiceId: "inv1", registrationId: null })
    expect(orderLinkOf(new URLSearchParams("registration=reg1"))).toEqual({ invoiceId: null, registrationId: "reg1" })
    expect(orderLinkOf(new URLSearchParams("o=&order="))).toBeNull()
  })
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

describe("Check your code's links", () => {
  // as main.ts reads a link: the path and the query after the hash
  const read = (url: string) => {
    const [path, query = ""] = url.replace(/^\/#/, "").split("?")
    return { view: viewOf(new URLSearchParams(), path), fromOrder: fromOrder(new URLSearchParams(query)) }
  }
  it("opens Check your code from the header's link, and from an order's page saying so", () => {
    expect(read(CODE_URL)).toEqual({ view: "code", fromOrder: false })
    expect(read(CODE_FROM_ORDER_URL)).toEqual({ view: "code", fromOrder: true })
  })
})

describe("editUrl", () => {
  it("opens Edit links of the order, which the edit route reads back", () => {
    const url = editUrl("reg-1_A")
    expect(url).toBe("/#/edit/reg-1_A")
    const path = url.slice("/#".length)
    expect(viewOf(new URLSearchParams(), path)).toBe("edit")
    expect(EDIT_PATH.exec(path)?.[1]).toBe("reg-1_A")
  })
})
