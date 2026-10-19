import type { PageMotion } from "./machine.ts"

export type View = "search" | "checkout" | "name-code" | "order" | "names" | "restore" | "edit" | "trademarks"

export const EDIT_PATH = /^\/edit\/([\w-]+)$/

export function viewOf(query: URLSearchParams, path: string): View {
  if (query.get("order") || query.get("registration")) return "order"
  if (path === "/checkout") return "checkout"
  if (path === "/checkout/code") return "name-code"
  if (path === "/names") return "names"
  if (path === "/restore") return "restore"
  if (path === "/trademarks") return "trademarks"
  if (EDIT_PATH.test(path)) return "edit"
  return "search"
}

const FORWARD = "forward"
const BACK = "back"
export const routes: { readonly [From in View]: Readonly<Record<View, PageMotion>> } = {
  search: { search: FORWARD, checkout: FORWARD, "name-code": FORWARD, order: FORWARD, names: FORWARD, restore: FORWARD, edit: FORWARD, trademarks: FORWARD },
  checkout: { search: BACK, checkout: FORWARD, "name-code": FORWARD, order: FORWARD, names: FORWARD, restore: FORWARD, edit: FORWARD, trademarks: FORWARD },
  "name-code": { search: BACK, checkout: BACK, "name-code": FORWARD, order: FORWARD, names: FORWARD, restore: FORWARD, edit: FORWARD, trademarks: FORWARD },
  order: { search: BACK, checkout: BACK, "name-code": BACK, order: FORWARD, names: FORWARD, restore: FORWARD, edit: FORWARD, trademarks: FORWARD },
  names: { search: BACK, checkout: BACK, "name-code": BACK, order: FORWARD, names: FORWARD, restore: FORWARD, edit: FORWARD, trademarks: FORWARD },
  restore: { search: BACK, checkout: BACK, "name-code": BACK, order: FORWARD, names: BACK, restore: FORWARD, edit: FORWARD, trademarks: FORWARD },
  edit: { search: BACK, checkout: BACK, "name-code": BACK, order: FORWARD, names: BACK, restore: FORWARD, edit: FORWARD, trademarks: FORWARD },
  trademarks: { search: BACK, checkout: FORWARD, "name-code": FORWARD, order: FORWARD, names: FORWARD, restore: FORWARD, edit: FORWARD, trademarks: FORWARD },
}
