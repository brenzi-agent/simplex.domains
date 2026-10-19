import { expect, type Page } from "@playwright/test"
import { AXIS_MS } from "../src/motion-values.ts"
import { markStep, recordCuts, takeCuts, takeTransitions, type Transition } from "./cuts.ts"
import { channelLink, contactLink, control, fades, pressInPlace, REGISTRATION_MS, registrationOf, settle, startOrder, test, uniqueLabel, waitRegistered } from "./helpers.ts"

// The other specs run with reduced motion, which the page honours; these watch the motion itself.
test.use({ reducedMotion: "no-preference" })

// a production build, as BASE_URL serves one, has no source modules to import
const SOURCE_LESS = process.env.BASE_URL !== undefined
// within a page's 260 ms fade in
const PREVIEW_LAG_MS = 120
// within a part's 240 ms height easing
const NESTED_LAG_MS = 100
// past a page's 300 ms view transition, which waits a frame or more for the browser's picture of the old page
const CHECK_LAG_MS = 800
// a page change's view transition twice over
const FRAMES_MS = 2 * AXIS_MS
// a height that moves less than this keeps still
const STILL_PX = 0.5
// what is drawn fainter than this is not seen; a fade through may pass through it for a frame or two, not longer
const BLANK_OPACITY = 0.05
const MAX_BLANK_MS = 50
// what stays whole is drawn at least this opaque throughout
const SOLID_OPACITY = 0.9
const STATIC_GROUPS = /^(root|page(-old)?|page-top|page-foot(-old)?|offline-note|page-title|page-lead|crumbs|step-ring|step-(line|done)-[\w-]+|order-card(-body)?|page-panel(-body)?|order-name)$/
const expectStaticGroups = (t: Transition) => expect(t.groups.filter((g) => !STATIC_GROUPS.test(g)), t.groups.join(" ")).toEqual([])

// how long a reveal has still to run a frame after it starts, at least, to be seen as one rather than a cut
const MIN_REVEAL_LEFT_MS = 100
const revealsAfterPress = (page: Page, press: string, watch: string, property: string) => page.evaluate(([press, watch, property, least]) => new Promise<boolean>((done) => {
  document.querySelector<HTMLElement>(press)!.click()
  requestAnimationFrame(() => done(document.querySelector(watch)!.getAnimations().some((a) => {
    const effect = a.effect as KeyframeEffect | null
    const timing = effect?.getComputedTiming()
    const left = Number(timing?.endTime ?? 0) - Number(timing?.localTime ?? 0)
    return a.playState === "running" && left >= least && (effect?.getKeyframes().some((k) => property in k) ?? false)
  })))
}), [press, watch, property, MIN_REVEAL_LEFT_MS] as const)

test.beforeEach(async ({ page }) => {
  await page.addInitScript(recordCuts)
})

test.afterEach(async ({ request }) => {
  await control(request, "search", { chainDown: false, limitSeconds: 0, invoiceError: null, cancelStillOpen: false, findLimitSeconds: 0 })
})

test("searching eases results in and out, a repeated search keeps still, and a pause comes and goes smoothly", async ({ page, request }) => {
  await page.goto("/")
  await settle(page)
  const name = page.getByLabel("Name", { exact: true })
  await markStep(page, "first search")
  await name.fill(uniqueLabel("mfirst"))
  await name.press("Enter")
  await page.locator(".result").waitFor()
  await settle(page)
  await markStep(page, "second search")
  const second = uniqueLabel("msecond")
  await name.fill(second)
  await name.press("Enter")
  await page.locator(".result", { hasText: `${second}.simplex` }).waitFor()
  await settle(page)
  await markStep(page, "same search")
  await name.press("Enter")
  await expect(page.locator(".result.busy")).toHaveCount(0)
  await settle(page)
  await markStep(page, "taken name")
  await name.fill("bakery")
  await name.press("Enter")
  await page.locator(".result", { hasText: "bakery.simplex" }).waitFor()
  await settle(page)
  await control(request, "search", { limitSeconds: 2 })
  await markStep(page, "rate limit")
  const limited = uniqueLabel("mlimit")
  await name.fill(limited)
  await name.press("Enter")
  await page.locator(".result", { hasText: `${limited}.simplex` }).waitFor()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("popups, the theme switch and the phone menu ease in and out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  const fading = await fades(page)
  await settle(page)
  await markStep(page, "menu")
  expect(await revealsAfterPress(page, ".menu-btn", "header nav", "clipPath"), "the menu unrolls").toBe(true)
  await settle(page)
  await markStep(page, "popup")
  await page.getByRole("button", { name: "Check a code" }).click()
  await settle(page)
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("SN6-")
  await settle(page)
  await page.keyboard.press("Escape")
  await settle(page)
  await markStep(page, "theme")
  await takeTransitions(page)
  await page.getByLabel("Switch light or dark theme").click()
  await settle(page)
  const theme = await takeTransitions(page)
  expect(theme.map((t) => t.types)).toEqual(fading ? [] : [["theme"]])
  if (!fading) expect(theme[0].groups).toEqual(["root"])
  await page.getByLabel("Switch light or dark theme").click()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("checkout eases its link previews, method and code entry, and each page opens with a cross-fade", async ({ page }) => {
  const label = uniqueLabel("mcheck")
  await page.goto(`/#/?name=${label}`)
  await page.getByRole("button", { name: "Register" }).waitFor()
  await markStep(page, "to checkout")
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  await markStep(page, "link preview")
  await page.getByLabel("Address").fill("https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS")
  await page.locator(".link-field").first().locator(".entity:not(.skeleton)").waitFor()
  await settle(page)
  await markStep(page, "link error")
  await page.getByLabel("Channel").fill("hello")
  await settle(page)
  await page.getByLabel("Channel").fill("")
  await settle(page)
  await markStep(page, "method")
  await page.locator(".method", { hasText: "Monero" }).click()
  await settle(page)
  await markStep(page, "code entry")
  await page.getByText("I have a code").click()
  await settle(page)
  await markStep(page, "to name code")
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  await settle(page)
  await page.getByText("I have saved my code").click()
  await settle(page)
  await markStep(page, "to payment")
  await page.getByRole("button", { name: "Continue to payment" }).click()
  await page.getByRole("heading", { name: "Pay with Monero" }).waitFor()
  await settle(page)
  await markStep(page, "back and forward")
  await page.goBack()
  await page.locator(".result", { hasText: `${label}.simplex` }).waitFor()
  await settle(page)
  await page.goForward()
  await page.getByRole("heading", { name: "Pay with Monero" }).waitFor()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("an order's page eases through each stage to registered, Your names keeps still when another tab writes, and its edit page opened cold eases to its previews", async ({ page, request }) => {
  const label = uniqueLabel("mstage")
  const { invoiceId } = await startOrder(page, label, { method: "btc", contact: contactLink("M1"), channel: channelLink("M2") })
  await settle(page)
  await takeCuts(page)
  await markStep(page, "copy")
  await page.getByRole("button", { name: /^Copy / }).first().click()
  await expect(page.locator(".copy-btn.copied")).toHaveCount(1)
  await expect(page.locator(".copy-btn.copied")).toHaveCount(0)
  await settle(page)
  await markStep(page, "partial")
  await control(request, `partial/${invoiceId}`)
  await expect(page.getByText("Part of the payment arrived").first()).toBeVisible()
  await settle(page)
  await markStep(page, "confirming")
  await control(request, `confirming/${invoiceId}`)
  await expect(page.getByText(/^Waiting for (\d+\u00a0confirmations?|the payment to settle)$/).first()).toBeVisible()
  await settle(page)
  await markStep(page, "registering")
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await settle(page)
  await markStep(page, "to Your names")
  await page.getByRole("link", { name: "Your names" }).click()
  await page.locator(".row-item", { hasText: `${label}.simplex` }).waitFor()
  await settle(page)
  await markStep(page, "another tab")
  const other = await page.context().newPage()
  await other.goto("/")
  await other.evaluate(() => localStorage.setItem("simplex-names:code:SN6-MOTION", JSON.stringify({ code: "SN6-Z6VPA-7YPF0-XN8B4-9S1ZD", minLength: 6, years: 2, addedAt: new Date().toISOString() })))
  await page.locator(".code-row", { hasText: "SN6-Z6VPA-7YPF0-XN8B4-9S1ZD" }).waitFor()
  await settle(page)
  await other.close()
  await markStep(page, "show code")
  await page.getByText("Show code").first().click()
  await settle(page)
  await page.keyboard.press("Escape")
  await settle(page)
  await markStep(page, "forget")
  await page.getByText("Forget everything in this browser").click()
  await settle(page)
  await page.getByRole("button", { name: "Keep them" }).click()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
  // the link previews come in while the page itself still eases in
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route("**/api/link/preview", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_LAG_MS))
    await route.continue()
  })
  await page.goto(`/#/edit/${await registrationOf(request, invoiceId)}`)
  await markStep(page, "edit opened cold")
  await expect(page.locator(".link-field .entity:not(.skeleton)")).toHaveCount(2)
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("a page opened slides the way the reader goes, as the browser's view transitions, and Firefox before 158 fades it through", async ({ page }) => {
  await page.goto("/")
  const fading = await fades(page)
  await settle(page)
  await takeTransitions(page)
  const slid = fading ? slidesWhenLeaving(page) : null
  await page.locator("nav a[data-nav=names]").click()
  await settle(page)
  const [opened] = await takeTransitions(page)
  if (slid) {
    expect(opened).toBeUndefined()
    expect(await slid).toEqual({ leaving: ["-16px"], arriving: true })
  }
  else {
    expect(opened.types).toEqual(["forward"])
    expectStaticGroups(opened)
    for (const part of ["root", "page", "page-top", "page-foot"]) expect(opened.groups, part).toContain(part)
    expect(opened.animations).toContain("::view-transition-old(page) axis-out")
    expect(opened.animations).toContain("::view-transition-new(page) axis-in")
  }
  await expect(page.locator(".page-leaving")).toHaveCount(0)
  const slidBack = fading ? slidesWhenLeaving(page) : null
  await page.locator("nav a[data-nav=search]").click()
  await settle(page)
  const back = await takeTransitions(page)
  expect(back.map((t) => t.types)).toEqual(fading ? [] : [["back"]])
  if (fading) expect(await slidBack).toEqual({ leaving: ["16px"], arriving: true })
  if (!fading) expect(back[0].animations).toContain("::view-transition-old(page) axis-out")
  expect(await takeCuts(page)).toEqual([])
})

const slidesWhenLeaving = (page: Page) => page.evaluate(() => new Promise<{ leaving: string[]; arriving: boolean }>((done) => {
  const slides = (n: Element) => n.getAnimations().map((a) => (a.effect as KeyframeEffect).getKeyframes()).filter((k) => k.some((f) => "translate" in f))
  new MutationObserver((_, watch) => {
    const leaving = document.querySelector(".page-leaving")
    if (!leaving) return
    watch.disconnect()
    done({ leaving: slides(leaving).map((k) => String(k[k.length - 1].translate)), arriving: [...document.querySelectorAll("body > main *")].some((n) => slides(n).length > 0) })
  }).observe(document.body, { childList: true })
}))

const nameMove = (page: Page) => page.evaluate(() => new Promise<{ from: number[]; was: number[] }>((done, fail) => {
  let was: number[] = []
  addEventListener("click", () => {
    const r = document.querySelector("main .result .order-name")!.getBoundingClientRect()
    was = [r.left, r.top]
  }, { capture: true, once: true })
  const start = performance.now()
  const look = () => {
    const name = document.querySelector("body > main:not(.pending) .summary .order-name")
    const move = name?.getAnimations().map((a) => (a.effect as KeyframeEffect).getKeyframes()).find((k) => k.some((f) => "translate" in f))
    if (move) return done({ from: String(move[0].translate).split(" ").map(parseFloat), was })
    if (performance.now() - start > 5000) return fail(new Error("the card's name never moved"))
    requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
}))

interface FadeFrame { t: number; card: number; total: number; button: number; panel: number; leaving: number }
const fadeThroughFrames = (page: Page, ms: number) => page.evaluate((ms) => new Promise<FadeFrame[]>((done) => {
  const frames: FadeFrame[] = []
  const drawn = (n: Element | null) => {
    if (!n || getComputedStyle(n).visibility === "hidden") return 0
    let opacity = 1
    for (let a: Element | null = n; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity)
    return opacity
  }
  const most = (selector: string) => Math.max(0, ...[...document.querySelectorAll(selector)].map(drawn))
  const start = performance.now()
  const sample = () => {
    frames.push({ t: performance.now() - start, card: drawn(document.querySelector("body > main:not(.pending) .summary")), total: most(".summary .total"), button: most(".summary .btn"),
      panel: most(".cols > .panel:first-child > *"), leaving: document.querySelectorAll(".page-leaving").length })
    if (performance.now() - start < ms) requestAnimationFrame(sample)
    else done(frames)
  }
  requestAnimationFrame(sample)
}), ms)
const longestBlank = (frames: FadeFrame[], kind: "button" | "panel") => {
  let longest = 0
  let from: number | null = null
  for (const f of frames) {
    if (f[kind] >= BLANK_OPACITY) from = null
    else longest = Math.max(longest, f.t - (from ??= f.t))
  }
  return longest
}

interface BodyFrame { bodies: { fit: string[] }[]; name: string; fading: boolean }
const BODIES = ["order-card-body", "page-panel-body"]
const bodyFrames = (page: Page, ms: number) => page.evaluate(([ms, bodies]) => new Promise<BodyFrame[]>((done) => {
  const frames: BodyFrame[] = []
  const style = (side: string, name: string) => getComputedStyle(document.documentElement, `::view-transition-${side}(${name})`)
  const start = performance.now()
  const sample = () => {
    // Playwright's WebKit closes the page when asked for the document's animations in each frame of a view transition
    if (document.documentElement.matches(":active-view-transition")) {
      frames.push({ bodies: bodies.map((name) => ({ fit: [style("old", name).objectFit, style("new", name).objectFit] })),
        name: style("group", "order-name").transform, fading: bodies.some((name) => Number(style("old", name).opacity) < 1 || Number(style("new", name).opacity) < 1) })
    }
    if (performance.now() - start < ms) requestAnimationFrame(sample)
    else done(frames)
  }
  requestAnimationFrame(sample)
}), [ms, BODIES] as const)

test("the next step of an order keeps its steps and card where they are, moving the ring on, filling the line to it and turning the step left to a tick; Back moves back", async ({ page }) => {
  await page.goto(`/#/?name=${uniqueLabel("mstep")}`)
  const fading = await fades(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  await takeTransitions(page)
  const frames = fading ? fadeThroughFrames(page, FRAMES_MS) : null
  const pictured = fading ? null : bodyFrames(page, FRAMES_MS)
  await pressInPlace(page, "Continue")
  await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  await settle(page)
  const [next] = await takeTransitions(page)
  if (frames) {
    expect(next).toBeUndefined()
    const seen = await frames
    expect(Math.min(...seen.map((f) => f.card)), "the card does not fade").toBeGreaterThan(0.99)
    expect(Math.min(...seen.map((f) => f.total)), "the card's total stays whole").toBeGreaterThan(SOLID_OPACITY)
    expect(longestBlank(seen, "button"), "the card's button is never gone").toBeLessThanOrEqual(MAX_BLANK_MS)
    expect(longestBlank(seen, "panel"), "the panel's content is never gone").toBeLessThanOrEqual(MAX_BLANK_MS)
    const quick = fadeThroughFrames(page, FRAMES_MS)
    await page.evaluate(() => new Promise<void>((done) => {
      addEventListener("popstate", () => requestAnimationFrame(() => {
        ;[...document.querySelectorAll<HTMLElement>("body > main:not(.pending) .btn")].find((b) => b.textContent?.trim() === "Continue")!.click()
        done()
      }), { once: true })
      history.back()
    }))
    await page.getByRole("heading", { name: "Save your name code" }).waitFor()
    expect(Math.max(...(await quick).map((f) => f.leaving)), "leaving pages never stack").toBeLessThanOrEqual(1)
    await settle(page)
    await expect(page.locator(".page-leaving")).toHaveCount(0)
    return expect(await takeCuts(page)).toEqual([])
  }
  expect(next.types).toEqual(["forward"])
  expectStaticGroups(next)
  for (const part of ["page", "order-card", "page-title", "crumbs", "step-ring", "step-line-name-code", "step-done-details"]) expect(next.groups, part).toContain(part)
  for (const part of ["order-card", "page-title", "crumbs", "step-ring"]) expect(next.animations).toContain(`::view-transition-group(${part}) -ua-view-transition-group-anim-${part}`)
  expect(next.animations).toContain("::view-transition-old(page-title) fade-out")
  expect(next.animations).toContain("::view-transition-new(page-title) appear")
  expect(next.animations.filter((a) => /\((page-title|crumbs|order-card)\) axis-/.test(a))).toEqual([])
  expect(next.animations).toContain("::view-transition-new(step-line-name-code) fill-across")
  expect(next.animations).toContain("::view-transition-new(step-done-details) tick-in")
  expect(next.animations.filter((a) => /::view-transition-(old|new)\(root\)/.test(a))).toEqual([])
  expect(next.animations).toContain("::view-transition-old(page) axis-out")
  expect(next.animations).toContain("::view-transition-new(page) axis-in")
  for (const part of ["page-panel", ...BODIES]) expect(next.groups, part).toContain(part)
  const seen = (await pictured!).filter((f) => f.fading)
  expect(seen.length, "the bodies' pictures were seen crossing").toBeGreaterThan(0)
  BODIES.forEach((name, i) => expect([...new Set(seen.flatMap((f) => f.bodies[i].fit))], `${name}: its pictures are not stretched`).toEqual(["none"]))
  if (await page.evaluate(() => CSS.supports("view-transition-group", "nearest"))) expect([...new Set(seen.map((f) => f.name))], "the name's place within the card's body").toHaveLength(1)
  await page.goBack()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  const [back] = await takeTransitions(page)
  expect(back.types).toEqual(["back"])
  expect(back.groups).toContain("step-ring")
  expect(back.animations).toContain("::view-transition-old(page) axis-out")
  expect(await takeCuts(page)).toEqual([])
})

// a page left this far down and the next drawn from its top
const SCROLLED_PX = 300
// The largest move down or up that Firefox before 158 gives a part of the page it fades through.
const largestSlide = (page: Page) => page.evaluate(() => new Promise<number>((done) => {
  new MutationObserver((_, watch) => {
    if (!document.querySelector(".page-leaving")) return
    watch.disconnect()
    const frames = [...document.querySelectorAll("body > main *")].flatMap((n) => n.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes()))
    done(Math.max(0, ...frames.filter((f) => "translate" in f).map((f) => Math.abs(parseFloat(String(f.translate).split(" ")[1] ?? "0")))))
  }).observe(document.body, { childList: true })
}))

test("a page change that scrolls the window pairs none of the pages' parts, so none slides across the screen or over the panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#/?name=${uniqueLabel("mscroll")}`)
  const fading = await fades(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await settle(page)
  expect(await page.evaluate(() => scrollY), "the checkout scrolled to its foot").toBeGreaterThan(SCROLLED_PX)
  await takeTransitions(page)
  const pictured = async (types: string[], slid: Promise<number> | null) => {
    const [t] = await takeTransitions(page)
    if (slid) {
      expect(t).toBeUndefined()
      return expect(await slid, "the largest move of a part up or down").toBeLessThanOrEqual(STILL_PX)
    }
    expect(t.types).toEqual(types)
    const carried = t.animations.filter((a) => /^::view-transition-group\((?!root\)|page-top\))/.test(a))
    expect(carried, "only the header is carried across").toEqual([])
  }
  const slid = fading ? largestSlide(page) : null
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  await settle(page)
  expect(await page.evaluate(() => scrollY), "the name code's page opens at its top").toBe(0)
  await pictured(["forward", "far"], slid)
  const slidBack = fading ? largestSlide(page) : null
  await page.goBack()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  expect(await page.evaluate(() => scrollY), "Back returns to the checkout where it was left").toBeGreaterThan(SCROLLED_PX)
  await pictured(["back", "far"], slidBack)
  expect(await takeCuts(page)).toEqual([])
})

test("the theme's cross-fade pictures the new theme whole, with no control still easing to its colours", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Playwright's WebKit closes the page when asked for a view transition's animations")
  await page.goto(`/#/?name=${uniqueLabel("mtheme")}`)
  test.skip(await fades(page), "Firefox before 158 eases the colours instead")
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  const easing = await page.evaluate(async () => {
    const w = window as unknown as { __lastTransition: ViewTransition | null }
    const before = w.__lastTransition
    document.querySelector<HTMLElement>("[aria-label='Switch light or dark theme']")!.click()
    while (w.__lastTransition === before) await new Promise(requestAnimationFrame)
    await w.__lastTransition!.ready
    return document.getAnimations().filter((a) => a instanceof CSSTransition)
      .map((a) => `${((a.effect as KeyframeEffect).target as Element).className} ${(a as CSSTransition).transitionProperty}`)
  })
  expect(easing).toEqual([])
  await settle(page)
})

const PAGE_SHOWN = 0.5
const FADE_STEP_MS = 5
const fadeThroughShown = (page: Page, start: "register" | "back") => page.evaluate(([start, step, span]) => new Promise<{ t: number; shown: number }[]>((done) => {
  const drawn = (n: Element) => {
    let opacity = 1
    for (let a: Element | null = n; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity)
    return opacity
  }
  const alpha = (color: string) => {
    const parts = /rgba?\(([^)]+)\)/.exec(color)?.[1].split(/[\s,/]+/).filter(Boolean) ?? []
    return parts.length === 0 ? 0 : parts.length > 3 ? Number(parts[3]) : 1
  }
  const sample = () => {
    const animations = document.getAnimations()
    animations.forEach((a) => a.pause())
    const frames: { t: number; shown: number }[] = []
    for (let t = 0; t <= span; t += step) {
      animations.forEach((a) => { a.currentTime = t })
      const leaving = document.querySelector(".page-leaving")
      const old = leaving ? drawn(leaving) : 0
      const boxes = [...document.querySelectorAll("body > main:not(.pending) *")].map((n) => alpha(getComputedStyle(n).backgroundColor) * drawn(n))
      frames.push({ t, shown: 1 - (1 - old) * (1 - Math.max(0, ...boxes)) })
    }
    animations.forEach((a) => a.play())
    done(frames)
  }
  if (start === "back") {
    addEventListener("popstate", sample, { once: true })
    history.back()
    return
  }
  ;[...document.querySelectorAll<HTMLElement>("body > main .btn")].find((b) => b.textContent?.trim() === "Register")!.click()
  sample()
}), [start, FADE_STEP_MS, FRAMES_MS / 2] as const)

test("Firefox before 158 fading a page through never shows a near-blank page between the two, either way", async ({ page }) => {
  await page.goto(`/#/?name=${uniqueLabel("mdip")}`)
  test.skip(!await fades(page), "a view transition draws the page change here")
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  const forward = await fadeThroughShown(page, "register")
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  const back = await fadeThroughShown(page, "back")
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  for (const [way, frames] of [["forward", forward], ["back", back]] as const) {
    const least = frames.reduce((low, f) => f.shown < low.shown ? f : low)
    expect(least.shown, `${way}: the least of a page drawn, at ${least.t} ms`).toBeGreaterThanOrEqual(PAGE_SHOWN)
  }
})

test("Firefox before 158 fading a page through around the order's name is no cut, and a card box shown at once is one", async ({ page }) => {
  await page.goto(`/#/?name=${uniqueLabel("mbox")}`)
  test.skip(!await fades(page), "a view transition draws the page change here")
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  await takeCuts(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  await page.goBack()
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
  await page.evaluate(() => {
    const animate = Element.prototype.animate
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      return Array.isArray(keyframes) && keyframes.some((k) => "backgroundColor" in k) ? animate.call(this, [], 0) : animate.call(this, keyframes, options)
    }
  })
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  const cuts = await takeCuts(page)
  expect(cuts.some((c) => c.kind === "cut-in" && c.what.startsWith("main.page")), JSON.stringify(cuts)).toBe(true)
})

test("codes applied and removed at checkout and on search fade across, with nothing left out of the old page", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const useCode = async () => {
    await page.getByRole("button", { name: "Check a code" }).click()
    await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
    await expect(page.locator(".verdict.ok")).toBeVisible()
    await page.getByRole("button", { name: "Use this code" }).click()
    await settle(page)
  }
  await page.goto(`/#/?name=${uniqueLabel("mcode")}`)
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  await markStep(page, "code on search")
  const scrolls = page.evaluate(() => new Promise<number>((done) => {
    let seen = 0
    addEventListener("scroll", () => { seen += 1 })
    const used = (e: Event) => {
      if ((e.target as Element).closest("button")?.textContent?.trim() !== "Use this code") return
      document.removeEventListener("click", used, true)
      seen = 0
      setTimeout(() => done(seen), 1500)
    }
    document.addEventListener("click", used, true)
  }))
  await page.evaluate(() => scrollTo(0, 0))
  await useCode()
  expect(await scrolls, "scrolls after Use this code").toBe(0)
  await markStep(page, "remove on search")
  await page.locator(".covered").getByText("Remove").click()
  await settle(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await page.getByLabel("Address").fill("https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS")
  await page.locator(".link-field").first().locator(".entity:not(.skeleton)").waitFor()
  await settle(page)
  await takeCuts(page)
  await markStep(page, "code at checkout")
  await useCode()
  await markStep(page, "remove at checkout")
  await page.getByText("Remove the code").click()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("Your names fades out what it takes away: a pending row, a Find link with nothing to find, everything forgotten", async ({ page }) => {
  for (const prefix of ["mpend", "mfind"]) {
    await page.goto(`/#/?name=${uniqueLabel(prefix)}`)
    await page.getByRole("button", { name: "Register" }).click()
    await page.getByRole("button", { name: "Continue" }).click()
    await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  }
  await page.goto("/#/names")
  await page.locator(".row-item").first().waitFor()
  await settle(page)
  await takeCuts(page)
  await markStep(page, "find with nothing to find")
  await page.locator(".row-item").first().getByText("Find the order").click()
  await expect(page.locator(".row-item").first().getByText("Find the order")).toHaveCount(0)
  await settle(page)
  await markStep(page, "remove a pending row")
  await page.locator(".row-item").first().getByText("Remove", { exact: true }).click()
  await settle(page)
  await markStep(page, "forget everything")
  await page.getByText("Forget everything in this browser").click()
  await settle(page)
  await page.getByRole("button", { name: "Forget everything" }).click()
  await expect(page.locator(".row-item")).toHaveCount(0)
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("forgetting everything eases Your names' panel once, down to its note, never past it and back", async ({ page }) => {
  await page.goto(`/#/?name=${uniqueLabel("mforget")}`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  await page.goto("/#/names")
  await page.locator(".row-item").first().waitFor()
  await page.getByText("Forget everything in this browser").click()
  await page.getByRole("button", { name: "Keep them" }).waitFor()
  await settle(page)
  const heights = await page.evaluate((ms) => new Promise<number[]>((done) => {
    const panel = document.querySelector("body > main .panel")!
    const seen: number[] = []
    ;[...document.querySelectorAll<HTMLElement>("body > main .btn")].find((b) => b.textContent?.trim() === "Forget everything")!.click()
    const start = performance.now()
    const sample = () => {
      seen.push(panel.getBoundingClientRect().height)
      if (performance.now() - start < ms) requestAnimationFrame(sample)
      else done(seen)
    }
    requestAnimationFrame(sample)
  }), FRAMES_MS * 2)
  const grew = heights.findIndex((h, i) => i > 0 && h > heights[i - 1] + STILL_PX)
  expect(grew, `the panel's heights: ${heights.map(Math.round).join(" ")}`).toBe(-1)
  expect(heights.at(-1)!, "it ends lower than it started").toBeLessThan(heights[0])
  await expect(page.getByText("No names in this browser yet.")).toBeVisible()
  expect(await takeCuts(page)).toEqual([])
})

// Each frame after Find the order is pressed in the first row that has it: where Remove, the fading Find and the old chip are.
interface FindFrame { remove: number; find: number | null; findOpacity: number; chip: number | null }
const findFrames = (page: Page) => page.evaluate(() => new Promise<{ before: { find: number; chip: number }; frames: FindFrame[] }>((done) => {
  const isFind = (b: Element) => b.textContent?.trim() === "Find the order"
  const row = [...document.querySelectorAll(".row-item")].find((r) => [...r.querySelectorAll(".small-btn")].some(isFind))!
  const left = (n: Element | null | undefined) => n ? n.getBoundingClientRect().left : null
  const buttons = () => [...row.querySelectorAll<HTMLElement>(".small-btn")]
  const find = buttons().find(isFind)!
  const before = { find: left(find)!, chip: left(row.querySelector(".chip"))! }
  const frames: FindFrame[] = []
  const start = performance.now()
  find.click()
  const sample = () => {
    const going = row.querySelector(".small-btn.outgoing")
    frames.push({
      remove: left(buttons().find((b) => b.textContent?.trim() === "Remove" && !b.classList.contains("outgoing")))!,
      find: left(going), findOpacity: going ? Number(getComputedStyle(going).opacity) : 0, chip: left(row.querySelector(".outgoing .chip")),
    })
    if (performance.now() - start < 2000) requestAnimationFrame(sample)
    else done({ before, frames })
  }
  requestAnimationFrame(sample)
}))

test("a Find link with nothing to find fades where it stood, and what was beside it moves only once it has mostly gone", async ({ page }) => {
  for (const prefix of ["mwide", "mphone"]) {
    await page.goto(`/#/?name=${uniqueLabel(prefix)}`)
    await page.getByRole("button", { name: "Register" }).click()
    await page.getByRole("button", { name: "Continue" }).click()
    await page.getByRole("heading", { name: "Save your name code" }).waitFor()
  }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/#/names")
    await page.locator(".row-item").first().waitFor()
    await settle(page)
    await takeCuts(page)
    const { before, frames } = await findFrames(page)
    const fading = frames.filter((f) => f.find !== null)
    expect(fading.length, `${width}px: Find fades out`).toBeGreaterThan(2)
    for (const f of fading) expect(Math.abs(f.find! - before.find), `${width}px: Find stays where it stood`).toBeLessThan(1)
    const oldChip = frames.find((f) => f.chip !== null)
    expect(Math.abs(oldChip!.chip! - before.chip), `${width}px: the old chip fades from where it was`).toBeLessThan(1)
    const moved = frames.find((f) => Math.abs(f.remove - frames[0].remove) > 1)
    // in one row Remove is at its end, where it stays; rows wrap their buttons onto a line of their own at 760 px
    if (width > 760) expect(moved, `${width}px: Remove stays where it is`).toBeUndefined()
    else if (moved) expect(moved.findOpacity, `${width}px: Remove moves only once Find has mostly gone`).toBeLessThan(0.5)
    await settle(page)
    expect(await takeCuts(page)).toEqual([])
  }
})

test("a code's Use coming back slides Copy and the chip aside rather than jumping them there", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, state: "reserved" }) as { code: string }
  await page.goto("/")
  await page.evaluate((code) => localStorage.setItem(`simplex-names:code:${code}`, JSON.stringify({ code, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await page.goto("/#/names")
  const row = page.locator(".code-row", { hasText: code })
  await expect(row.locator(".chip:not(.outgoing .chip)")).toHaveText("In use")
  await expect(row.getByText("Use", { exact: true })).toHaveCount(0)
  await control(request, "code/state", { code, state: "unused" })
  await page.getByRole("link", { name: "Search" }).click()
  await settle(page)
  await takeCuts(page)
  // the service answers once Your names is on screen, as a slower one would; a quick answer draws Use with the page
  await page.route("**/api/code/check", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, CHECK_LAG_MS))
    await route.continue()
  })
  await markStep(page, "Use comes back")
  // Your names opened again shows the code as read last time, without Use, until the service answers it is unused
  const frames = await page.evaluate(([code, settled]) => new Promise<{ copy: number; chip: number }[]>((done) => {
    const out: { copy: number; chip: number }[] = []
    document.querySelector<HTMLElement>("nav a[data-nav=names]")!.click()
    const start = performance.now()
    const sample = () => {
      const row = [...document.querySelectorAll("main:not(.pending) .code-row")].find((r) => r.textContent!.includes(code))
      const copy = row && [...row.querySelectorAll(".small-btn")].find((b) => b.textContent!.trim() === "Copy" && !b.closest(".outgoing"))
      const chip = row?.querySelector(".chip:not(.outgoing .chip)")
      if (copy && chip && performance.now() - start > settled) out.push({ copy: copy.getBoundingClientRect().left, chip: chip.getBoundingClientRect().left })
      if (performance.now() - start < 2000) requestAnimationFrame(sample)
      else done(out)
    }
    requestAnimationFrame(sample)
  }), [code, FRAMES_MS] as const)
  await expect(row.getByText("Use", { exact: true })).toBeVisible()
  // Use goes in before Copy, at the row's end, so Copy stays and the chip makes room: it must move, over frames
  const xs = frames.map((f) => Math.round(f.chip))
  const [first, last] = [xs[0], xs[xs.length - 1]]
  expect(Math.abs(last - first), `the chip moves ${first}→${last}`).toBeGreaterThan(10)
  expect(xs.filter((x) => (x - first) * (last - x) > 0).length, `the chip eases over frames ${xs.join(",")}`).toBeGreaterThan(2)
  expect(new Set(frames.map((f) => Math.round(f.copy))).size, "Copy stays where it is").toBe(1)
  expect(await takeCuts(page)).toEqual([])
})

test("a part that grows while the part around it eases carries it on, rather than snapping when that easing ends", async ({ page }) => {
  test.skip(SOURCE_LESS, "it drives the dev server's own source modules")
  await page.goto("/#/trademarks")
  await settle(page)
  type Parts = { outer: HTMLElement; inner: HTMLElement; block: (height: number) => HTMLElement }
  // the app's own copy of the motion module, as a second copy would watch the same parts and fight over them
  await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/motion.ts"))!
    const { live } = await import(url) as typeof import("../src/motion.ts")
    const block = (height: number) => Object.assign(document.createElement("div"), { textContent: `${height} px` }, { style: `height: ${height}px` })
    const outer = live(document.createElement("div"))
    const inner = live(document.createElement("div"))
    inner.append(block(50))
    outer.append(inner, block(100))
    document.querySelector("main")!.prepend(outer)
    ;(window as unknown as { parts: Parts }).parts = { outer, inner, block }
  })
  await settle(page)
  await takeCuts(page)
  await markStep(page, "nested growth")
  await page.evaluate(async (lagMs) => {
    const { outer, inner, block } = (window as unknown as { parts: Parts }).parts
    outer.replaceChildren(inner, block(300))
    await new Promise((resolve) => setTimeout(resolve, lagMs))
    inner.replaceChildren(block(250))
  }, NESTED_LAG_MS)
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("content put into a part a moment before a page change is pictured as last drawn, not jumped to the end of its fade", async ({ page }) => {
  test.skip(SOURCE_LESS, "it drives the dev server's own source modules")
  await page.goto("/#/trademarks")
  test.skip(await fades(page), "the fade through moves the old page as it is, with no picture of it taken")
  await settle(page)
  type Moved = { part: HTMLElement; go: (url: string) => void }
  // the app's own modules, as a second copy would watch the same parts and fight over them
  await page.evaluate(async () => {
    const loaded = (path: string) => performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes(path))!
    const { live } = await import(loaded("/src/motion.ts")) as typeof import("../src/motion.ts")
    const { go } = await import(loaded("/src/views/shell.ts")) as typeof import("../src/views/shell.ts")
    const part = live(document.createElement("div"))
    document.querySelector("main")!.prepend(part)
    ;(window as unknown as { moved: Moved }).moved = { part, go }
  })
  await settle(page)
  await takeCuts(page)
  const pictured = await page.evaluate(() => new Promise<string>((done) => {
    const { part, go } = (window as unknown as { moved: Moved }).moved
    const start = document.startViewTransition.bind(document)
    document.startViewTransition = ((arg: StartViewTransitionOptions) => {
      document.startViewTransition = start
      done(getComputedStyle(part.querySelector("span")!).opacity)
      return start(arg)
    }) as typeof document.startViewTransition
    part.replaceChildren("after")
    queueMicrotask(() => go("/#/"))
  }))
  expect(pictured, "the new content's opacity as the browser takes its picture of the old page").toBe("0")
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("the phone menu and a popup opened again while they fade carry on from where they were", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await settle(page)
  // Pressed from inside the page, 60 ms apart, as a test click would wait for the fade to end first; the opacity just
  // before the second press and a frame after it, which goes on up from there rather than starting again from nothing.
  const pressAgainMidFade = (close: string, open: string, watch: string) => page.evaluate(([close, open, watch]) => new Promise<number[]>((done) => {
    document.querySelector<HTMLElement>(close)!.click()
    setTimeout(() => {
      const before = Number(getComputedStyle(document.querySelector(watch)!).opacity)
      document.querySelector<HTMLElement>(open)!.click()
      requestAnimationFrame(() => done([before, Number(getComputedStyle(document.querySelector(`${watch}:not(.closing)`)!).opacity)]))
    }, 60)
  }), [close, open, watch])
  const carriesOn = ([before, after]: number[]) => expect(after).toBeGreaterThanOrEqual(before - 0.02)
  await markStep(page, "menu again mid-fade")
  await page.getByLabel("Menu").click()
  await settle(page)
  carriesOn(await pressAgainMidFade(".menu-btn", ".menu-btn", "header nav"))
  await settle(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await settle(page)
  await markStep(page, "popup again mid-fade")
  await page.getByRole("button", { name: "Check a code" }).click()
  await settle(page)
  carriesOn(await pressAgainMidFade(".modal-overlay .icon-btn", ".ghost-btn", ".modal-overlay"))
  await settle(page)
  await page.keyboard.press("Escape")
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("an edit page opened cold and a paused order keep their shape: no placeholder flash, no button that resizes", async ({ page, request }) => {
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "12" }, json: { error: "rate_limited" } }) : route.continue())
  await page.goto(`/#/?name=${uniqueLabel("mwait")}&owner=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  const again = page.getByRole("button", { name: /Try again in/ })
  await again.waitFor()
  const widths = new Set<number>()
  for (let i = 0; i < 3; i++) {
    widths.add(Math.round((await again.boundingBox())!.width))
    await page.waitForTimeout(1000)
  }
  expect([...widths]).toHaveLength(1)
  await page.unroute("**/api/invoice")
  await control(request, "search", { chainDown: false, limitSeconds: 0, invoiceError: null, cancelStillOpen: false, findLimitSeconds: 0 })
  expect(await takeCuts(page)).toEqual([])
})

test("the name goes from its result into the order's card, a button at work spins at its own size, the wait's line fills, and Your names' rows rise in one after another", async ({ page, request }) => {
  const label = uniqueLabel("mmoment")
  await page.goto(`/#/?name=${label}`)
  const fading = await fades(page)
  await page.getByRole("button", { name: "Register" }).waitFor()
  await settle(page)
  await takeTransitions(page)
  await markStep(page, "to checkout")
  const moved = fading ? nameMove(page) : null
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("heading", { name: "Check your order" }).waitFor()
  await settle(page)
  const [toCheckout] = await takeTransitions(page)
  if (moved) {
    const { from, was } = await moved
    const now = (await page.locator("main .summary .order-name").boundingBox())!
    expect(Math.abs(from[0] - (was[0] - now.x)), `starts ${from} from ${was} to ${now.x},${now.y}`).toBeLessThan(2)
    expect(Math.abs(from[1] - (was[1] - now.y)), `starts ${from} from ${was} to ${now.x},${now.y}`).toBeLessThan(2)
  } else {
    expectStaticGroups(toCheckout)
    expect(toCheckout.animations, "the name goes over from its result to the card").toContain("::view-transition-group(order-name) -ua-view-transition-group-anim-order-name")
  }
  await markStep(page, "working button")
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByText("I have saved my code").click()
  await page.route("**/api/invoice", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, CHECK_LAG_MS))
    await route.continue()
  })
  const pay = page.getByRole("button", { name: "Continue to payment" })
  const idle = (await pay.boundingBox())!.width
  await pay.click()
  await expect(page.locator(".btn.working[aria-busy=true]")).toHaveCount(1)
  expect(Math.round((await page.locator(".btn.working").boundingBox())!.width)).toBe(Math.round(idle))
  await page.getByRole("heading", { name: "Pay with Bitcoin" }).waitFor()
  await page.unrouteAll({ behavior: "wait" })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/")
  await markStep(page, "code order")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await settle(page)
  await page.getByRole("button", { name: "Use this code" }).click()
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(uniqueLabel("mwait"))
  await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with code" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByText("I have saved my code").click()
  await takeTransitions(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.locator(".stage.active", { hasText: "Waiting" }).waitFor({ timeout: REGISTRATION_MS })
  if (!fading) {
    const toOrder = await takeTransitions(page)
    toOrder.forEach(expectStaticGroups)
    expect(toOrder.some((t) => t.groups.includes("order-card")), toOrder.map((t) => `${t.types}: ${t.groups.join(" ")}`).join(" | ")).toBe(true)
  }
  // Read as a frame draws it: between frames an animation stands where the last frame put it, while the countdown's timer runs on the clock.
  const filled = () => page.evaluate(() => new Promise<number>((done) => requestAnimationFrame(() => {
    const step = [...document.querySelectorAll("body > main:not(.pending) .stage")].find((s) => s.textContent!.includes("Waiting"))!
    done(step.classList.contains("done") ? 1 : Number(getComputedStyle(step).getPropertyValue("--done")))
  })))
  const first = await filled()
  await expect.poll(filled, { message: "the line fills as the wait goes" }).toBeGreaterThan(first)
  // the clock's icon once the wait is over, not the one fading out as the count came in
  await page.locator(".countdown b > svg").waitFor({ timeout: REGISTRATION_MS })
  expect(await filled(), "the line is full when the wait ends").toBe(1)
  await markStep(page, "Your names")
  await page.evaluate(() => {
    const w = window as unknown as { rising: Promise<number[]> }
    w.rising = new Promise((done) => {
      const watch = new MutationObserver(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("body > main .row-item")]
        if (!rows.length) return
        watch.disconnect()
        done(rows.filter((r) => r.classList.contains("entering")).map((r) => parseFloat(getComputedStyle(r).animationDelay)))
      })
      watch.observe(document.body, { childList: true, subtree: true })
    })
  })
  await page.locator("nav a[data-nav=names]").click()
  const delays = await page.evaluate(() => (window as unknown as { rising: Promise<number[]> }).rising)
  expect(delays.length, "rows rising in").toBeGreaterThan(1)
  expect(delays[1], "each row a little after the one before").toBeGreaterThan(delays[0])
  await page.evaluate(() => localStorage.setItem("simplex-names:code:SN6-REDRAW", JSON.stringify({ code: "SN6-Z6VPA-7YPF0-XN8B4-9S1ZD", minLength: 6, years: 2, addedAt: new Date().toISOString() })))
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "simplex-names:code:SN6-REDRAW" })))
  await settle(page)
  await expect(page.locator(".row-item.entering")).toHaveCount(0)
  expect(await takeCuts(page)).toEqual([])
})

test("a cancelled invoice, an expired one and a name taken first each move on smoothly, never pictured mid-fade", async ({ page, request }) => {
  const label = uniqueLabel("mcancel")
  await startOrder(page, label, { method: "btc" })
  await settle(page)
  await takeCuts(page)
  await markStep(page, "cancel")
  await page.getByText("Cancel this invoice").click()
  await page.getByRole("heading", { name: "Invoice cancelled" }).waitFor()
  await settle(page)
  await markStep(page, "order again")
  await page.getByRole("button", { name: "Order the name again" }).click()
  await page.locator(".result", { hasText: `${label}.simplex` }).waitFor()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await settle(page)
  await takeCuts(page)
  await markStep(page, "expired")
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("heading", { name: "Invoice expired" }).waitFor()
  await settle(page)
  await markStep(page, "new invoice")
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  await page.getByRole("heading", { name: "Pay with Bitcoin" }).waitFor()
  await settle(page)
  await markStep(page, "taken")
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, "take", { label })
  await control(request, `settle/${second}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: REGISTRATION_MS })
  await settle(page)
  await markStep(page, "another name")
  await page.getByRole("button", { name: "Choose another name" }).click()
  await expect(page.getByText(/Your payment is kept: \$100\.00/)).toBeVisible()
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})
