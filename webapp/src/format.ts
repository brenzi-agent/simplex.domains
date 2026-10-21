// How amounts, dates and addresses read on the page.

// cents only where an amount has them, as "$100" and "$100.50"
export function dollars(cents: number): string {
  const digits = cents % 100 === 0 ? 0 : 2
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

// word joiners keep a shortened address on one line
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}\u2060…\u2060${address.slice(-4)}`
}

export function letters(n: number): string {
  return n === 1 ? "1 letter" : `${n} letters`
}

// the day stays with its month on one line
export function dateOf(seconds: number, short = false): string {
  return new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: short ? "short" : "long", year: "numeric", timeZone: "UTC" }).replace(" ", "\u00a0")
}

// a dot between parts of a line stays at the end of the part before it, never starting a line
export const SEP = "\u00a0\u00b7 "

// The names' term starts on 1 January 2027 (owner 2026-10-20); the days before it are free. A later wave takes this date
// from the service's termStart.
export const TERM_START_S = Date.UTC(2027, 0, 1) / 1000
const DAY_S = 86400

export const freeDays = (nowS: number) => Math.max(0, Math.ceil((TERM_START_S - nowS) / DAY_S))

// where a term of these years ends, counted from its start, or from now once the start has passed
export function termEnd(years: number, nowS: number): number {
  const end = new Date(Math.max(nowS, TERM_START_S) * 1000)
  end.setUTCFullYear(end.getUTCFullYear() + years)
  return end.getTime() / 1000
}

export function termText(years: number): string {
  return `${years} years + 30 days`
}

export function seconds(n: number): string {
  return n === 1 ? "1 second" : `${n} seconds`
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function methodName(method: string): string {
  return ({ card: "Card", btc: "Bitcoin", xmr: "Monero", code: "Code" } as Record<string, string>)[method] ?? method
}
