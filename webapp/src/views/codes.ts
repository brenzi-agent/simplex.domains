// The prepaid code field that checkout and Your names share, judged as it is typed.
import * as api from "../api.ts"
import { codeProgress, parseNameCode } from "../crypto/code.ts"
import { seconds } from "../format.ts"
import { el, icon, liveRegion } from "../dom.ts"
import type * as session from "../session.ts"
import { kept } from "./shell.ts"

export type CodeVerdict =
  | { ok: true; code: session.AppliedCode; line: string }
  | { ok: false; title: string; line: string }

const STATE_LINES: Record<Exclude<api.CodeState, "unused">, [string, string]> = {
  reserved: ["This code is being used for a name now", "Each code registers one name; this one is held by an unfinished registration."],
  used: ["This code was already used", "Each code registers one name."],
  revoked: ["This code is not valid", "SimpleX withdrew it, so it cannot be used."],
  expired: ["This code has expired", "It can no longer register a name."],
  unpaid: ["This code is not paid for yet", "It works once its payment is confirmed."],
}

// what the service's code errors at checkout say, where the code was entered
export const CODE_ERRORS: Record<string, string> = {
  code_invalid: "This code is not valid.",
  code_used: "This code was already used.",
  code_reserved: "This code is being used for a name now.",
  code_expired: "This code has expired.",
  payment_pending: "This code is not paid for yet.",
  code_not_covering: "This code does not cover this name.",
}

const unused = (code: session.AppliedCode): CodeVerdict => ({ ok: true, code, line: `Covers names of ${code.minLength} or more letters, for ${code.years} years.` })

const MISTYPED: CodeVerdict = { ok: false, title: "This code is not valid", line: "Check it for a mistyped character." }

// A typo or an owner code is answered on the page; anything else asks the service, which spends nothing.
async function judgeCode(text: string): Promise<CodeVerdict> {
  const parsed = parseNameCode(text)
  if (parsed === null) return MISTYPED
  if (parsed.kind === "owner") return { ok: false, title: "This is a name code", line: "It owns a name. Restore it in Your names." }
  try {
    const answer = await api.checkCode(parsed.display)
    if (answer.state === "unused") return unused({ display: parsed.display, minLength: answer.minLength, years: answer.years })
    const [title, line] = STATE_LINES[answer.state]
    return { ok: false, title, line }
  } catch (e) {
    // well formed but unknown to the service: not a typo, which the check digit would have caught
    if (e instanceof api.ApiError && e.code === "code_invalid") return { ok: false, title: "This code is not valid", line: "SimpleX did not issue it, or withdrew it." }
    if (e instanceof api.ApiError && e.code === "rate_limited") return { ok: false, title: "Too many checks just now", line: `Your code may be fine. Try again in ${seconds(e.retryAfter ?? api.LIMITED_WAIT_S)}.` }
    return { ok: false, title: "The code could not be checked", line: "Try again in a moment." }
  }
}

// The pause after the last key before a code typed in full is judged; one pasted whole is judged at once.
const JUDGE_PAUSE_MS = 400

// A code field judged as it is typed: no verdict while the code is on its way, a character no code has at once, and a
// code long enough to judge once typing pauses. show gets null while there is nothing to say.
function watchCode(input: HTMLInputElement, show: (v: CodeVerdict | null) => void): void {
  let seq = 0
  let pause: ReturnType<typeof setTimeout> | undefined
  const judge = async (mine: number) => {
    const v = await judgeCode(input.value.trim())
    if (mine === seq && input.isConnected) show(v)
  }
  input.addEventListener("input", (e) => {
    const mine = ++seq
    clearTimeout(pause)
    const progress = codeProgress(input.value)
    if (progress === "empty" || progress === "partial") return show(null)
    if (progress === "impossible") return show(MISTYPED)
    if ((e as InputEvent).inputType === "insertFromPaste") void judge(mine)
    else pause = setTimeout(() => void judge(mine), JUDGE_PAUSE_MS)
  })
}

const said = (v: CodeVerdict) => v.ok ? v.line : `${v.title}. ${v.line}`

/** A kept code field with its verdict line under it. `judged` hears each verdict, null while there is nothing to judge,
 * and may return a refusal to say instead. A field opened with `start` shows that code as judged. */
export function codeField(key: string, label: string, judged: (v: CodeVerdict | null) => string | null, start: session.AppliedCode | null = null): HTMLElement {
  return kept(key, () => {
    const input = el("input", { type: "text", "aria-label": label, spellcheck: "false", placeholder: "SN6-…", autocomplete: "off", value: start?.display })
    const box = el("label", { class: "field code-input" }, icon("key"), input)
    const line = liveRegion("verdict")
    const show = (v: CodeVerdict | null, instead: string | null) => {
      const tone = instead !== null || v?.ok === false ? " bad" : v ? " ok" : ""
      box.className = `field code-input${tone}`
      line.className = `verdict${tone}`
      line.textContent = instead ?? (v ? said(v) : "")
    }
    if (start) show(unused(start), null)
    watchCode(input, (v) => show(v, judged(v)))
    return el("div", { class: "code-entry" }, el("span", { class: "label" }, label), box, line)
  })
}
