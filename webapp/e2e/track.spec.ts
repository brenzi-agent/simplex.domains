import { expect, type Page } from "@playwright/test"
import { openCode, search, startOrder, test, uniqueLabel } from "./helpers.ts"

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

test("search, checkout and payment move along one track a step at a time, the other steps inert", async ({ page }) => {
  await search(page, uniqueLabel("track"))
  await expect(page.locator(".rail > .slide")).toHaveCount(3)
  expect(await shift(page)).toBe(0)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeFocused()
  await expect.poll(() => shift(page)).toBe(-1)
  await expect(liveSlides(page)).toHaveCount(1)
  const before = await page.locator(".track").evaluate((t) => t.getBoundingClientRect().height)
  await openCode(page)
  await expect.poll(() => fit(page)).toBe(0)
  expect(await page.locator(".track").evaluate((t) => t.getBoundingClientRect().height)).toBeGreaterThan(before)
  await page.goBack()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  await expect.poll(() => shift(page)).toBe(0)
})

test("a payment screen is the track's third step, and Your names, restore and trademarks swap the whole page", async ({ page }) => {
  await startOrder(page, uniqueLabel("trackpay"), { method: "btc" })
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect.poll(() => shift(page)).toBe(-2)
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
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeFocused()
  expect(await slideMs(page)).toBe("0ms")
  await expect.poll(() => shift(page)).toBe(-1)
})
