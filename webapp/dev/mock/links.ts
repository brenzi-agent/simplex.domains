// The chat core's own form of a short link (simplexmq ConnShortLink strEncode): every server's host in `h`, the link's
// host first, joined by an escaped comma, then its port and key hash. A `simplex:/` link is in that form already.
const SHORT_HTTPS = /^https:\/\/([^/]+)\/([ac])#([^?]+)(?:\?(.*))?$/
const HOST_SEPARATOR = "%2C"
export function deepLinkOf(link: string): string {
  const parts = SHORT_HTTPS.exec(link)
  if (!parts) return link
  const [, host, type, key, query = ""] = parts
  const params = new URLSearchParams(query)
  const hosts = [host, ...(params.get("h")?.split(",") ?? [])]
  const rest = (["p", "c"] as const).flatMap((k) => { const v = params.get(k); return v ? [`${k}=${v}`] : [] })
  return `simplex:/${type}#${key}?${[`h=${hosts.join(HOST_SEPARATOR)}`, ...rest].join("&")}`
}
