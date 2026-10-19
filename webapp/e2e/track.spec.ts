import { expect, type Page } from "@playwright/test"
import {
  CODE_HEADING, contactLink, control, LINKS_HEADING, onStep, openCode, payButton, REGISTRATION_MS, savedToReview, search, shot, startOrder, test, uniqueLabel, waitRegistered,
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
  // a window short enough that the review's code field makes its step taller than the window
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
  await openCode(page)
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

test("a move to the next step slides; a first mount, a jump over a step and reduced motion move at once", async ({ page }) => {
  // the config asks every page for reduced motion
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

// The screen in view fits the window at each size, its content centred between the header and the footer unless it is
// the home, which lays itself out as the landing does; and is captured for review when shots are asked for.
async function fitsWindow(page: Page, name: string, centred = true): Promise<void> {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const measured = () => page.evaluate(() => {
      const shown = document.querySelector(".slide:not([inert]) > *, body > main > .screen")!
      const kids = [...shown.children].filter((k) => k.getBoundingClientRect().height > 0)
      const above = kids[0].getBoundingClientRect().top - document.querySelector("body > header")!.getBoundingClientRect().bottom
      const below = document.querySelector("body > footer")!.getBoundingClientRect().top - kids.at(-1)!.getBoundingClientRect().bottom
      return { overflow: Math.max(0, document.scrollingElement!.scrollHeight - innerHeight), offCentre: Math.round(Math.abs(above - below)) }
    })
    // an offset within the bound reads as none, so a failure shows how far off it is
    await expect.poll(async () => {
      const { overflow, offCentre } = await measured()
      return { overflow, offCentre: centred && offCentre > CENTRE_PX ? offCentre : 0 }
    }, { message: `${name} at ${size.width}x${size.height}` }).toEqual({ overflow: 0, offCentre: 0 })
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, `names-7c-${name}`)
}

test("every purchase step fits a laptop's and a phone's window without scrolling, centred between the header and the footer", async ({ page, request }) => {
  await page.goto("/")
  await fitsWindow(page, "1-home", false)
  const label = uniqueLabel("fit")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  await step.getByLabel("Address").fill(contactLink("F2"))
  await expect(step.locator(".link-field").first().locator(".entity:not(.skeleton)")).toBeVisible()
  await fitsWindow(page, "2-links")
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await fitsWindow(page, "3-code")
  await savedToReview(page)
  await fitsWindow(page, "4-review")
  await openCode(page)
  await fitsWindow(page, "4b-review-code")
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await fitsWindow(page, "5-pay-bitcoin")
  await control(request, `settle/${new URL(page.url()).searchParams.get("order")}`)
  await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
  await fitsWindow(page, "6-registering")
  await waitRegistered(page, label)
  await fitsWindow(page, "7-registered")
  await startOrder(page, uniqueLabel("fitcard"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await fitsWindow(page, "5b-pay-card")
})
