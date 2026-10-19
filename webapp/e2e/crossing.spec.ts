import { expect, type Page } from "@playwright/test"
import { recordCuts, takeCuts, takeTransitions } from "./cuts.ts"
import { control, fades, pressInPlace, settle, startOrder, test, uniqueLabel } from "./helpers.ts"
import { expectCovered, expectCrossing, expectFaintUnder, type Side, sweep } from "./sweep.ts"

// Every place where one thing gives way to another crosses: swept frame by frame with the animations paused, what goes
// and what comes never both read and never both thin out.
test.use({ reducedMotion: "no-preference" })
test.beforeEach(async ({ page }) => { await page.addInitScript(recordCuts) })

const NO_VT_SWEEP = "Playwright's WebKit closes the page when asked for a view transition's animations"
const SHOWN = "body > main:not(.pending)"
const pictures = (name: string): Record<string, Side> => ({
  [`old ${name}`]: { css: `::view-transition-old(${name})` }, [`new ${name}`]: { css: `::view-transition-new(${name})` },
})
// the old page, pictured apart from the new when the change scrolls the window
const pagePictures: Record<string, Side> = { "old page": { css: "::view-transition-old(page)", or: "::view-transition-old(page-old)" }, "new page": { css: "::view-transition-new(page)" } }
const crossed = (swept: Awaited<ReturnType<typeof sweep>>, ...names: string[]) => names.forEach((n) => expectCrossing(swept, `old ${n}`, `new ${n}`))
// Firefox before 158 fades a copy of the old page out while the new page's parts come in
const fadedThrough = (part: string): Record<string, Side> => ({ "old page": { css: ".page-leaving" }, "new page": { css: `${SHOWN} ${part}` } })

async function skipViewTransitionsInWebKit(page: Page, browserName: string): Promise<boolean> {
  const fading = await fades(page)
  test.skip(browserName === "webkit" && !fading, NO_VT_SWEEP)
  return fading
}

test("a page change crosses the old page into the new either way, the name crossing as it travels and its card filling in once it has landed", async ({ page, browserName }) => {
  await page.goto(`/#/?name=${uniqueLabel("xpage")}`)
  const fading = await skipViewTransitionsInWebKit(page, browserName)
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  const forward = fading
    ? sweep(page, { within: ".page-leaving" }, fadedThrough("h1"))
    : sweep(page, { transition: true }, { ...pagePictures, ...pictures("order-name"), "card body": { css: "::view-transition-new(order-card-body)" },
      "name over the card's words": { over: ["::view-transition-group(order-name)", `${SHOWN} .summary > .box-body > .label, ${SHOWN} .summary .rows`] } })
  await page.getByRole("button", { name: "Register" }).click()
  const there = await forward
  expectCrossing(there, "old page", "new page")
  if (!fading) {
    crossed(there, "order-name")
    expectFaintUnder(there, "name over the card's words", "card body")
  }
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  const back = sweep(page, fading ? { within: ".page-leaving" } : { transition: true }, fading ? fadedThrough("h1") : pagePictures)
  await page.goBack()
  expectCrossing(await back, "old page", "new page")
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("the next step crosses the card's and the panel's insides, the heading and the step bar where they stand", async ({ page, browserName }) => {
  await page.goto(`/#/?name=${uniqueLabel("xstep")}`)
  const fading = await skipViewTransitionsInWebKit(page, browserName)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  const swept = fading
    ? sweep(page, { within: ".page-leaving" }, {
      "old card": { css: `${SHOWN} .summary > .box-body > .outgoing` }, "new card": { css: `${SHOWN} .summary > .box-body > .btn:not(.outgoing)` },
      "old panel": { css: `${SHOWN} .cols > .panel:first-child > .outgoing` }, "new panel": { css: `${SHOWN} .cols > .panel:first-child > .box-body:not(.outgoing) h2` },
    })
    : sweep(page, { transition: true }, { ...pictures("order-card-body"), ...pictures("page-panel-body"), ...pictures("page-title"), ...pictures("crumbs"),
      "old card box": { css: "::view-transition-old(order-card)" } })
  await pressInPlace(page, "Continue")
  const s = await swept
  if (fading) {
    expectCrossing(s, "old card", "new card")
    expectCrossing(s, "old panel", "new panel")
  } else {
    crossed(s, "order-card-body", "page-panel-body", "page-title", "crumbs")
    expect(Math.min(...s.frames.map((f) => f.at["old card box"])), "the card's box stays whole under the new one").toBe(1)
  }
  await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("a part payment crosses the amount, the QR code and the note in their places", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("xpart"), { method: "btc" })
  await settle(page)
  const swept = sweep(page, { within: `${SHOWN} .amount` }, {
    "old amount": { css: `${SHOWN} .amount.live > .outgoing` }, "new amount": { css: `${SHOWN} .amount.live > :not(.outgoing)` },
    "old code": { css: `${SHOWN} .qr.live > .outgoing` }, "new code": { css: `${SHOWN} .qr.live > :not(.outgoing)` },
  })
  await control(request, `partial/${invoiceId}`)
  const s = await swept
  expectCrossing(s, "old amount", "new amount")
  expectCrossing(s, "old code", "new code")
  await page.getByText("Part of the payment arrived").first().waitFor()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

// a name code of the right shape that no order was made with
const UNKNOWN_NAME_CODE = "SN-GE65A-H60EF-815JQ-DT70X-DH67M-Q7M9J"
test("a button at work crosses its label into its spinner, and back", async ({ page }) => {
  await page.goto("/#/restore")
  await page.getByLabel("Name code").fill(UNKNOWN_NAME_CODE)
  await settle(page)
  let answer: () => void = () => undefined
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await page.route("**/api/registration/find", async (route) => {
    await answered
    await route.continue()
  })
  const [working, settling] = [`${SHOWN} .btn.working`, `${SHOWN} .btn.settling`]
  const busy = sweep(page, { within: working }, { label: { css: working, color: true }, spinner: { css: `${working}::after` } })
  await page.getByRole("button", { name: "Restore" }).click()
  expectCrossing(await busy, "label", "spinner")
  await settle(page)
  const idle = sweep(page, { within: settling }, { spinner: { css: `${settling}::after` }, label: { css: settling, color: true } })
  answer()
  expectCrossing(await idle, "spinner", "label")
  await page.unrouteAll({ behavior: "wait" })
})

test("a popup and the offline note bring their surface before their words and take their words away first", async ({ page, context }) => {
  await page.goto("/")
  await settle(page)
  const overlay = { surface: { css: ".modal-overlay" }, words: { css: ".modal-overlay .modal > *" } }
  const opening = sweep(page, { within: ".modal-overlay" }, overlay)
  await page.getByRole("button", { name: "Check a code" }).click()
  expectCovered(await opening, "surface", "words", true)
  await settle(page)
  const closing = sweep(page, { within: ".modal-overlay" }, overlay)
  await page.keyboard.press("Escape")
  expectCovered(await closing, "surface", "words", false)
  await settle(page)
  const note = { surface: { css: ".offline-note" }, words: { css: ".offline-note > *" } }
  const offline = sweep(page, { within: ".offline-note" }, note)
  await context.setOffline(true)
  await page.evaluate(() => dispatchEvent(new Event("offline")))
  expectCovered(await offline, "surface", "words", true)
  await settle(page)
  const online = sweep(page, { within: ".offline-note" }, note)
  await context.setOffline(false)
  await page.evaluate(() => dispatchEvent(new Event("online")))
  expectCovered(await online, "surface", "words", false)
  await settle(page)
})

// the most a part of the page may move up or down while the window scrolls a little under a page change
const STILL_PX = 0.5
// the share of the window's height below which a scroll still pairs the order's card, PAIRED_SCROLL_SHARE in motion-values.ts
const NEAR_SCROLL_SHARE = 0.25
// what a page change carries across when the window scrolls a little: the window and header, which stay, and the order's card and name
const NEAR_PAIRED = ["root", "page-top", "offline-note", "order-card", "order-card-body", "order-name"]
test("a page change that scrolls the window a little pairs only the order's card and name, so the page never slides by the scroll", async ({ page, browserName }) => {
  await page.goto(`/#/?name=${uniqueLabel("xnear")}`)
  const fading = await skipViewTransitionsInWebKit(page, browserName)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await settle(page)
  const scrolled = await page.evaluate(() => scrollY / innerHeight)
  expect(scrolled > 0 && scrolled < NEAR_SCROLL_SHARE, `the checkout scrolled a little: ${scrolled} of the window's height`).toBe(true)
  await takeTransitions(page)
  const slid = fading ? page.evaluate(() => new Promise<number>((done) => {
    new MutationObserver((_, watch) => {
      if (!document.querySelector(".page-leaving")) return
      watch.disconnect()
      const moved = [...document.querySelectorAll("body > main *")].filter((n) => !n.closest(".summary, .order-name"))
      const frames = moved.flatMap((n) => n.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes()))
      done(Math.max(0, ...frames.filter((f) => "translate" in f).map((f) => Math.abs(parseFloat(String(f.translate).split(" ")[1] ?? "0")))))
    }).observe(document.body, { childList: true })
  })) : null
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  await settle(page)
  expect(await page.evaluate(() => scrollY), "the name code's page opens at its top").toBe(0)
  const [t] = await takeTransitions(page)
  if (slid) {
    expect(t).toBeUndefined()
    expect(await slid, "the largest move up or down of a part outside the card").toBeLessThanOrEqual(STILL_PX)
  } else {
    expect(t.types).toEqual(["forward", "near"])
    const moved = [...new Set(t.animations.map((a) => /^::view-transition-group\(([\w-]+)\)/.exec(a)?.[1]).filter((n): n is string => n !== undefined))]
    expect(moved.filter((name) => !NEAR_PAIRED.includes(name)), `parts carried across: ${moved}`).toEqual([])
    expect(moved, "the card carried to its place").toContain("order-card")
    expect(t.animations.filter((a) => a.startsWith("::view-transition-old(page)")), "the old page pictured as one with the new").toEqual([])
    expect(t.groups, "the old page and the new each cross where they stand").toEqual(expect.arrayContaining(["page-old", "page"]))
  }
  expect(await takeCuts(page)).toEqual([])
})

test("Firefox before 158 grows or shrinks the travelling name along its way from the size it had in its result", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#/?name=${uniqueLabel("xgrow")}`)
  test.skip(!await fades(page), "a view transition carries the name's picture at its size")
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  const was = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("main .result .order-name")!).fontSize))
  const scaled = page.evaluate(() => new Promise<string[]>((done) => {
    new MutationObserver((_, watch) => {
      const name = document.querySelector("body > main:not(.pending) .summary .order-name")
      const scales = name?.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes()).filter((k) => "scale" in k).map((k) => String(k.scale))
      if (!scales?.length) return
      watch.disconnect()
      done(scales)
    }).observe(document.body, { childList: true, subtree: true })
  }))
  await page.getByRole("button", { name: "Register" }).click()
  const now = await page.locator("main .summary .order-name").evaluate((n) => parseFloat(getComputedStyle(n).fontSize))
  expect(was, "the result's name and the card's are drawn at different sizes here").not.toBe(now)
  const [from, to] = await scaled
  expect(Number(from), "the name starts at the size it had").toBeCloseTo(was / now, 3)
  expect(Number(to)).toBe(1)
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})
