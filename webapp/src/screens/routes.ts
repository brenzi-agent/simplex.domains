export type View = "search" | "checkout" | "order" | "names" | "restore" | "edit" | "trademarks"
export type CheckoutStep = "links" | "code" | "review"

export const EDIT_PATH = /^\/edit\/([\w-]+)$/
const CHECKOUT_PATH = /^\/checkout(?:\/(links|code))?$/

export function viewOf(query: URLSearchParams, path: string): View {
  if (query.get("order") || query.get("registration")) return "order"
  if (CHECKOUT_PATH.test(path)) return "checkout"
  if (path === "/names") return "names"
  if (path === "/restore") return "restore"
  if (path === "/trademarks") return "trademarks"
  if (EDIT_PATH.test(path)) return "edit"
  return "search"
}

export const checkoutStepOf = (path: string): CheckoutStep => (CHECKOUT_PATH.exec(path)?.[1] as CheckoutStep | undefined) ?? "review"
export const checkoutUrl = (step: CheckoutStep) => step === "review" ? "/#/checkout" : `/#/checkout/${step}`
