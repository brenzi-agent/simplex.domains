// The prepaid code field that checkout and Your names share, judged as it is typed.
import * as api from "../api.ts"
import { codeProgress, parseNameCode } from "../crypto/code.ts"
import { seconds, termText } from "../format.ts"
import { el, icon, liveRegion } from "../dom.ts"
import type * as session from "../session.ts"
import { kept, whenDropped } from "./shell.ts"

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

export const CODE_ERRORS: Record<string, string> = {
  code_invalid: "This code is not valid.",
  code_used: "This code was already used.",
  code_reserved: "This code is being used for a name now.",
  code_expired: "This code has expired.",
  payment_pending: "This code is not paid for yet.",
  code_not_covering: "This code does not cover this name.",
}

const unused = (code: session.AppliedCode): CodeVerdict => ({ ok: true, code, line: `Covers names of ${code.minLength} or more letters, for ${termText(code.years)}.` })

const MISTYPED: CodeVerdict = { ok: false, title: "This code is not valid", line: "Check it for a mistyped character." }

// A typo or an owner code is answered on the page; anything else asks the service, which spends nothing.
async function judgeCode(text: string, signal: AbortSignal): Promise<CodeVerdict> {
  const parsed = parseNameCode(text)
  if (parsed === null) return MISTYPED
  if (parsed.kind === "owner") return { ok: false, title: "This is a name code", line: "It owns a name. Restore it in Your names." }
  try {
    const answer = await api.checkCode(parsed.display, signal)
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

// Each edit says nothing until its own verdict; a character no code has is refused at once, and a code long enough is
// judged once typing pauses. Nothing is judged once the signal ends; the result forgets a judgement on its way.
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
  return forget
}

const said = (v: CodeVerdict) => v.ok ? v.line : `${v.title}. ${v.line}`
// a field's way to take a refusal from elsewhere, as the service's when the order is sent
const refusers = new WeakMap<HTMLElement, (text: string) => void>()

/** A kept code field with its verdict line under it. `judged` hears each verdict, null while there is nothing to judge,
 * and may return a refusal to say instead. A field opened with `start` shows that code as judged, or `refusal` as said.
 * A field given an `action` shows it at the field's right end, as the search row does, with no label over it. */
export function codeField(key: string, label: string, judged: (v: CodeVerdict | null) => string | null,
  start: session.AppliedCode | null = null, refusal: string | null = null, action: HTMLElement | null = null): HTMLElement {
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
    if (start || refusal) show(start && unused(start), refusal)
    const life = new AbortController()
    whenDropped(() => life.abort())
    const forget = watchCode(input, (v) => show(v, judged(v)), life.signal)
    const entry = el("div", { class: "code-entry" }, action ? el("div", { class: "field-row" }, box, action) : [el("span", { class: "label" }, label), box], line)
    refusers.set(entry, (text) => {
      forget()
      input.value = ""
      show(null, text)
      input.focus()
    })
    return entry
  })
}

/** Empties the field and says why its code was refused, with focus in the field for another code. */
export const refuseCode = (entry: HTMLElement, text: string) => refusers.get(entry)?.(text)
