import { expect, type Page } from "@playwright/test"
import { MAX_LABEL_LENGTH } from "../src/names.ts"
import {
  channelLink, checkoutCode, CODE_HEADING, contactLink, control, LINKS_HEADING, onStep, openCode, payButton, REGISTRATION_MS, savedToReview, search, shot, startOrder, test, uniqueLabel,
  waitRegistered,
} from "./helpers.ts"

// the rail's shift in slides: its translateX over the track's width
const shift = (page: Page) => page.locator(".rail").evaluate((rail) => {
  const x = new DOMMatrix(getComputedStyle(rail).transform).m41
  return Math.round(x / rail.parentElement!.getBoundingClientRect().width)
})
// the slide's duration the last move set on the rail
const slideMs = (page: Page) => page.locator(".rail").evaluate((rail) => (rail as HTMLElement).style.getPropertyValue("--slide"))
// the track's height over the height of the slide in view, which it follows rounded up to a whole pixel
const fit = (page: Page) => page.locator(".slide:not([inert])").evaluate((slide) =>
  Math.round(slide.closest(".track")!.getBoundingClientRect().height - Math.ceil(slide.getBoundingClientRect().height)))
const liveSlides = (page: Page) => page.locator(".track > .rail > .slide:not([inert])")

test("search, links, name code, review and payment move along one track a step at a time, the other steps inert", async ({ page }) => {
  // a window short enough that the review is taller than it
  await page.setViewportSize({ width: 1280, height: 600 })
  await search(page, uniqueLabel("track"))
  await expect(page.locator(".rail > .slide")).toHaveCount(5)
  expect(await shift(page)).toBe(0)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeFocused()
  await expect.poll(() => shift(page)).toBe(-1)
  await onStep(page).getByRole("button", { name: "Skip for now" }).click()
  await expect(page.getByRole("heading", { name: CODE_HEADING })).toBeFocused()
  await expect.poll(() => shift(page)).toBe(-2)
  await savedToReview(page)
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeFocused()
  await expect.poll(() => shift(page)).toBe(-3)
  await expect(liveSlides(page)).toHaveCount(1)
  const before = await page.locator(".track").evaluate((t) => t.getBoundingClientRect().height)
  // the code field opens in its link's place; a code no code can be gets its verdict under it, which the track makes room for
  await openCode(page)
  await checkoutCode(page).fill("Q")
  await expect(onStep(page).locator(".verdict.bad")).toBeVisible()
  await expect.poll(() => fit(page)).toBe(0)
  expect(await page.locator(".track").evaluate((t) => t.getBoundingClientRect().height)).toBeGreaterThan(before)
  // Back walks the steps in reverse
  await page.goBack()
  await expect(page.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await expect.poll(() => shift(page)).toBe(-2)
  await page.goBack()
  await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await expect.poll(() => shift(page)).toBe(-1)
  await page.goBack()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  await expect.poll(() => shift(page)).toBe(0)
})

test("a payment screen is the track's last step, and Your names, restore and trademarks swap the whole page", async ({ page }) => {
  await startOrder(page, uniqueLabel("trackpay"), { method: "btc" })
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect.poll(() => shift(page)).toBe(-4)
  await page.getByRole("link", { name: "Your names" }).click()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(page.locator(".track")).toHaveCount(0)
  for (const [path, heading] of [["/#/restore", "Restore with a name code"], ["/#/trademarks", "Trademark owners"]]) {
    await page.goto(path)
    await expect(page.getByRole("heading", { name: heading })).toBeVisible()
    await expect(page.locator(".track")).toHaveCount(0)
  }
})

test("a move to the next step slides; a first mount, a jump over a step and a reader asking for less movement move at once", async ({ page }) => {
  // the config sets reducedMotion "reduce" for every page
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await startOrder(page, uniqueLabel("trackms"), { method: "btc" })
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  expect(await slideMs(page)).toBe("320ms")
  await page.reload()
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  expect(await slideMs(page)).toBe("0ms")
  await page.locator("a.brand").click()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  expect(await slideMs(page)).toBe("0ms")
  await expect.poll(() => shift(page)).toBe(0)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await search(page, uniqueLabel("trackrm"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeFocused()
  expect(await slideMs(page)).toBe("0ms")
  await expect.poll(() => shift(page)).toBe(-1)
})

// the sizes a purchase step must fit without scrolling, a laptop's and a phone's
const FIT_SIZES = [{ width: 1280, height: 800 }, { width: 390, height: 844 }]
// how far a step's content may sit off the middle between the header and the footer
const CENTRE_PX = 2

// Where the heading of the screen in view starts, once the track has taken its step's height, a frame after a change, and
// moved: under reduced motion its move is a transition too, of almost no length, which starts from where the track was.
const headingAt = (page: Page) => page.evaluate(async () => {
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))
  const box = (document.querySelector(".slide:not([inert]) h1") ?? document.querySelector("body > main h1"))!.getBoundingClientRect()
  return { x: Math.round(box.left), y: Math.round(box.top) }
})

// The screen in view fits the window at each size, its content centred between the header and the footer unless it is
// the home, which lays itself out as the landing does; and is captured for review when shots are asked for. Returns where
// its heading starts on the laptop's window.
async function fitsWindow(page: Page, name: string, centred = true): Promise<number> {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const measured = () => page.evaluate(() => {
      const shown = document.querySelector(".slide:not([inert]) > *, body > main > .screen")!
      const kids = [...shown.children].filter((k) => k.getBoundingClientRect().height > 0)
      const above = kids[0].getBoundingClientRect().top - document.querySelector("body > header")!.getBoundingClientRect().bottom
      const below = document.querySelector("body > footer")!.getBoundingClientRect().top - kids.at(-1)!.getBoundingClientRect().bottom
      // the track follows its step's height a frame or two after the window changes
      const track = document.querySelector(".track")
      const settled = !track || !shown.closest(".slide") || Math.round(track.getBoundingClientRect().height) === Math.ceil(shown.parentElement!.getBoundingClientRect().height)
      return { settled, overflow: Math.max(0, document.scrollingElement!.scrollHeight - innerHeight), offCentre: Math.round(Math.abs(above - below)) }
    })
    // an offset within the bound reads as none, so a failure shows how far off it is
    await expect.poll(async () => {
      const { settled, overflow, offCentre } = await measured()
      return { settled, overflow, offCentre: centred && offCentre > CENTRE_PX ? offCentre : 0 }
    }, { message: `${name} at ${size.width}x${size.height}` }).toEqual({ settled: true, overflow: 0, offCentre: 0 })
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, `names-g1-${name}`)
  return (await headingAt(page)).x
}

// widths a laptop's or a tablet's window has, from where the column first leaves margins beside it
const BACK_WIDTHS = [900, 1024, 1280]

// Back stays inside the window, beside the heading or above it
async function backInView(page: Page, name: string): Promise<void> {
  for (const width of BACK_WIDTHS) {
    await page.setViewportSize({ width, height: FIT_SIZES[0].height })
    const back = onStep(page).locator(".back")
    await expect.poll(async () => {
      const box = (await back.boundingBox())!
      return box.x >= 0 && box.x + box.width <= width
    }, { message: `${name}: Back at ${width} px wide` }).toBe(true)
  }
  await page.setViewportSize(FIT_SIZES[0])
}

test("every purchase step fits a laptop's and a phone's window without scrolling, centred in one column, and keeps still as it fills in", async ({ page, request }) => {
  await page.goto("/")
  await fitsWindow(page, "1-home", false)
  // a taken name with both its links, the tallest answer the home shows
  await search(page, "bakery")
  await expect(page.locator(".answer .entity")).toHaveCount(2)
  await fitsWindow(page, "1b-home-taken", false)
  const label = uniqueLabel("fit")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  const lefts: Record<string, number> = {}
  await expect(step.getByRole("heading", { name: LINKS_HEADING })).toBeFocused()
  await fitsWindow(page, "2a-links-empty")
  const linksAt = await headingAt(page)
  await step.getByLabel("Address").fill(contactLink("F2"))
  await step.getByLabel("Channel").fill(channelLink("G2"))
  for (const field of await step.locator(".link-field").all()) await expect(field.locator(".entity:not(.skeleton)")).toBeVisible()
  expect(await headingAt(page), "the links step as its previews come").toEqual(linksAt)
  lefts.links = await fitsWindow(page, "2-links")
  await backInView(page, "links")
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  lefts.code = await fitsWindow(page, "3-code")
  await savedToReview(page)
  lefts.review = await fitsWindow(page, "4-review")
  await backInView(page, "review")
  const reviewAt = await headingAt(page)
  await openCode(page)
  expect(await headingAt(page), "the review as its code field opens").toEqual(reviewAt)
  await fitsWindow(page, "4b-review-code")
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  lefts.payment = await fitsWindow(page, "5-pay-bitcoin")
  const invoiceId = new URL(page.url()).searchParams.get("order")
  await control(request, `confirming/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible()
  lefts.confirming = await fitsWindow(page, "5c-confirming")
  await control(request, `settle/${invoiceId}`)
  await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
  lefts.registering = await fitsWindow(page, "6-registering")
  await waitRegistered(page, label)
  lefts.registered = await fitsWindow(page, "7-registered")
  expect(new Set(Object.values(lefts)).size, `each step's heading starts at the column's edge: ${JSON.stringify(lefts)}`).toBe(1)
  await startOrder(page, uniqueLabel("fitcard"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await fitsWindow(page, "5b-pay-card")
})

// WebKit rounds the home's spacers to whole pixels anew as the content below them changes
const ROUNDING_PX = 1

test("the home keeps its headline and search still as each kind of answer comes, at a laptop's and a phone's size", async ({ page }) => {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await page.goto("/")
    // the frame's height is measured as the page is first laid out, and the fonts change the headline's
    await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
    const still = () => page.evaluate(() => ["h1", ".search-row"].map((s) => Math.round(document.querySelector(`.home ${s}`)!.getBoundingClientRect().top)))
    const before = await still()
    // each search on the same page, whose fonts have loaded
    for (const [name, answer] of [["bakery", ".entity"], ["harbour", ".note"], ["support", ".line"], ["abc", ".line"], [uniqueLabel("still"), ".price"]]) {
      await page.getByLabel("Name", { exact: true }).fill(name)
      await page.getByLabel("Name", { exact: true }).press("Enter")
      await expect(page.locator(`.answer ${answer}`).first()).toBeVisible()
      const moved = (await still()).map((at, i) => Math.abs(at - before[i]))
      expect(Math.max(...moved), `${name} at ${size.width}x${size.height}: headline and search moved ${moved}`).toBeLessThanOrEqual(ROUNDING_PX)
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight), `${name} at ${size.width}x${size.height}`).toBe(size.height)
    }
  }
})

// A name of the widest letters breaks its lines as early as any name of its length can; drawn at random from two
// letters, it is still new to the chain on each run.
const wideLabel = (length: number) => Array.from({ length }, () => (Math.random() < 0.5 ? "m" : "w")).join("")

for (const length of [15, 25, MAX_LABEL_LENGTH]) {
  test(`every purchase step fits both windows for a name of ${length} wide letters`, async ({ page, request }) => {
    const label = wideLabel(length)
    const shots = `long-${length}`
    await search(page, label)
    await expect(page.getByRole("button", { name: "Register" })).toBeEnabled()
    await fitsWindow(page, `${shots}-1-home`, false)
    await page.getByRole("button", { name: "Register" }).click()
    const step = onStep(page)
    await step.getByLabel("Address").fill(contactLink("W1"))
    await step.getByLabel("Channel").fill(channelLink("W2"))
    for (const field of await step.locator(".link-field").all()) await expect(field.locator(".entity:not(.skeleton)")).toBeVisible()
    await fitsWindow(page, `${shots}-2-links`)
    await step.getByRole("button", { name: "Continue" }).click()
    await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
    await fitsWindow(page, `${shots}-3-code`)
    await savedToReview(page)
    await fitsWindow(page, `${shots}-4-review`)
    await openCode(page)
    await fitsWindow(page, `${shots}-4b-review-code`)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
    await fitsWindow(page, `${shots}-5-pay-bitcoin`)
    await control(request, `settle/${new URL(page.url()).searchParams.get("order")}`)
    await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
    await fitsWindow(page, `${shots}-6-registering`)
    await waitRegistered(page, label)
    await fitsWindow(page, `${shots}-7-registered`)
  })
}
