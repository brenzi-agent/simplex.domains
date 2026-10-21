// The code field of Check your code, judged as it is typed: a prepaid code that pays for a name, or a name code that owns one.
import * as api from "../api.ts"
import { codeProgress, mayBeOwnerCode, parseNameCode } from "../crypto/code.ts"
import { seconds } from "../format.ts"
import { el, icon, liveRegion, refill } from "../dom.ts"
import * as flow from "../flow.ts"
import type * as session from "../session.ts"
import * as store from "../store.ts"
import { holdFrom } from "./hold.ts"
import { kept, whenDropped } from "./shell.ts"

export type CodeVerdict =
  | { kind: "prepaid"; code: session.AppliedCode; line: string }
  | { kind: "owner"; found: flow.CodeOrder; line: string }
  | { kind: "refused"; title: string; line: string; link?: string }

const STATE_LINES: Record<Exclude<api.CodeState, "unused">, [string, string]> = {
  reserved: ["This code is being used for a name now", "Each code registers one name; this one is held by an unfinished registration."],
  used: ["This code was already used", "Each code registers one name."],
  revoked: ["This code is not valid: SimpleX withdrew it", ""],
  expired: ["This code has expired", "It can no longer register a name."],
  unpaid: ["This code is not paid for yet", "It works once its payment is confirmed."],
}

// the service's refusals of a code an order carried
export const CODE_ERRORS: Record<string, string> = {
  code_invalid: "This code is not valid.",
  code_used: "This code was already used.",
  code_reserved: "This code is being used for a name now.",
  code_expired: "This code has expired.",
  payment_pending: "This code is not paid for yet.",
  code_not_covering: "This code does not cover this name.",
}

const coversLine = (code: session.AppliedCode) => `Prepaid code: it pays for a name of ${code.minLength} or more letters, for ${code.years} years.`
const unused = (code: session.AppliedCode): CodeVerdict => ({ kind: "prepaid", code, line: coversLine(code) })

const MISTYPED: CodeVerdict = { kind: "refused", title: "This code is not valid", line: "Check it for a mistyped character." }
const UNFINISHED: CodeVerdict = { kind: "refused", title: "This is not a SimpleX names code", line: "Check it and try again." }

const ownerLine = (name: string) => `Name code of ${name}.simplex. Adding it shows the name in Your names, where you can edit its links.`

// A refusal that asking again can change: a rate limit, or a service that did not answer.
function notChecked(e: unknown): CodeVerdict {
  if (e instanceof api.ApiError && e.code === "rate_limited") return { kind: "refused", title: "Too many checks just now", line: `Your code may be fine. Try again in ${seconds(e.retryAfter ?? api.LIMITED_WAIT_S)}.` }
  return { kind: "refused", title: "The code could not be checked", line: "Try again in a moment." }
}

// A name code is named by the order it restores, which only the code opens; a rate limit holds the tab's lookups too.
async function judgeNameCode(text: string): Promise<CodeVerdict> {
  try {
    const found = await flow.codeOrderOf(text)
    if (!found) return { kind: "refused", title: "This code does not open the order", line: "The order found for it was made with another code." }
    return { kind: "owner", found, line: ownerLine(found.name) }
  } catch (e) {
    if (e instanceof api.ApiError && e.code === "not_found") return { kind: "refused", title: "No order was found for this code", line: "The service has no order registered to its wallet." }
    holdFrom(e)
    return notChecked(e)
  }
}

// A typo is answered on the page; a prepaid code asks the service, which spends nothing, and a name code finds its orders.
async function judgeCode(text: string, signal: AbortSignal): Promise<CodeVerdict> {
  const parsed = parseNameCode(text)
  if (parsed === null) return MISTYPED
  if (parsed.kind === "owner") return judgeNameCode(text)
  try {
    const answer = await api.checkCode(parsed.display, signal)
    if (answer.state === "unused") return unused({ display: parsed.display, minLength: answer.minLength, years: answer.years })
    const [title, line] = STATE_LINES[answer.state]
    // the service names no order for a code in use; this browser's own order that holds it is linked
    const holder = answer.state === "reserved" ? store.orders().find((o) => o.prepaidCode === parsed.display) : undefined
    return { kind: "refused", title, line, link: holder && store.orderUrl(holder) }
  } catch (e) {
    // well formed but unknown to the service: not a typo, which the check digit would have caught
    if (e instanceof api.ApiError && e.code === "code_invalid") return { kind: "refused", title: "This code is not valid: SimpleX did not issue it", line: "" }
    return notChecked(e)
  }
}

// The pause after the last key before a code typed in full is judged; one pasted whole is judged at once.
const JUDGE_PAUSE_MS = 400

// Each edit says nothing until its own verdict; a character no code has is refused at once, and a code long enough is
// judged once typing pauses. One too short is refused once the reader is done: on Enter, or as focus leaves the field
// for the page, not for another window. Nothing is judged once the signal ends. The returned check judges the code at once.
function watchCode(input: HTMLInputElement, show: (v: CodeVerdict | null) => void, signal: AbortSignal): () => void {
  let seq = 0
  let pause: ReturnType<typeof setTimeout> | undefined
  const forget = () => {
    seq += 1
    clearTimeout(pause)
  }
  signal.addEventListener("abort", forget, { once: true })
  const judge = async (mine: number) => {
    const v = await judgeCode(input.value.trim(), signal)
    if (mine === seq && !signal.aborted) show(v)
  }
  input.addEventListener("input", (e) => {
    forget()
    const mine = seq
    const progress = codeProgress(input.value)
    if (progress === "impossible") return show(MISTYPED)
    show(null)
    if (progress === "empty" || progress === "partial") return
    if ((e as InputEvent).inputType === "insertFromPaste") void judge(mine)
    else pause = setTimeout(() => void judge(mine), JUDGE_PAUSE_MS)
  })
  const done = () => {
    if (signal.aborted || codeProgress(input.value) !== "partial") return
    forget()
    show(UNFINISHED)
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") done() })
  // Chromium blurs the field as a redraw moves it, and the redraw gives focus back before the check
  input.addEventListener("blur", () => queueMicrotask(() => { if (document.activeElement !== input && document.hasFocus()) done() }))
  return () => {
    if (signal.aborted || codeProgress(input.value) !== "complete") return done()
    forget()
    void judge(seq)
  }
}

const said = (v: CodeVerdict) => v.kind !== "refused" ? v.line : v.line ? `${v.title}. ${v.line}` : `${v.title}.`
// what was typed in a field, by its key, shown and judged again when its page is opened again
const typed = new Map<string, string>()

// `heard` hears each verdict, and nothing while the code is being typed.
export function codeField(key: string, label: string, heard: (v: CodeVerdict | null) => void): HTMLElement {
  return kept(key, () => {
    const verdictId = `${key}-verdict`
    const input = el("input", { type: "text", "aria-label": label, "aria-describedby": verdictId, spellcheck: "false", placeholder: "SN…", autocomplete: "off", value: typed.get(key) })
    const check = el("button", { class: "btn lens", type: "button", "aria-label": "Check" }, icon("search"))
    const box = el("label", { class: "field code-input" }, input, check)
    const line = liveRegion("verdict")
    line.id = verdictId
    const show = (v: CodeVerdict | null) => {
      const tone = v === null ? "" : v.kind === "refused" ? " bad" : " ok"
      box.className = `field code-input${tone}`
      line.className = `verdict${tone}`
      refill(line, v && said(v), v?.kind === "refused" && v.link ? [" ", el("a", { href: v.link }, "Open that order")] : null)
      heard(v)
    }
    const life = new AbortController()
    whenDropped(() => life.abort())
    check.addEventListener("click", watchCode(input, show, life.signal))
    // a name code is never kept to show again, nor most of one mistyped or cut short, as anyone who sees it can take the name
    input.addEventListener("input", () => {
      if (mayBeOwnerCode(input.value)) typed.delete(key)
      else typed.set(key, input.value)
    })
    // judged once the page that asked for the field is drawn, as a verdict may change the page
    if (input.value) queueMicrotask(() => input.dispatchEvent(new Event("input")))
    return el("div", { class: "code-entry" }, box, line)
  })
}
