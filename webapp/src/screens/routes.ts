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
