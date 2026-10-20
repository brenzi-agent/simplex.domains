import { expect, type Page } from "@playwright/test"
import {
  control, onStep, payButton, recordedFrames, recordFrames, registrationOf, savedToReview, search, startOrder, test, toCodeStep, uniqueLabel,
} from "./helpers.ts"

const SIZES = [{ width: 1280, height: 800 }, { width: 390, height: 844 }]
const BACK_PX = 40

// The screen in view: a purchase step on the track, or a screen that fills main alone.
const shownScreen = (page: Page) => page.locator(".slide:not([inert]) > section, body > main > section")

// Back sits wholly in the window as a 40 px circle at each size, and is the first stop after the header for the keyboard.
async function backReady(page: Page, name: string): Promise<void> {
  const back = shownScreen(page).locator(".back")
  await expect(back, `${name}: Back`).toHaveAttribute("aria-label", "Back")
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await expect(back, `${name} at ${size.width}x${size.height}: Back in the window`).toBeInViewport({ ratio: 1 })
    const drawn = await back.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return { width: Math.round(box.width), height: Math.round(box.height), radius: parseFloat(getComputedStyle(node).borderTopLeftRadius) }
    })
    expect(drawn, `${name} at ${size.width}x${size.height}: Back's box`).toEqual({ width: BACK_PX, height: BACK_PX, radius: expect.any(Number) })
    expect(drawn.radius, `${name}: Back is round`).toBeGreaterThanOrEqual(BACK_PX / 2)
    await page.locator(".theme-switch").focus()
    await page.keyboard.press("Tab")
    await expect(back, `${name} at ${size.width}x${size.height}: Tab from the header`).toBeFocused()
    expect(await back.evaluate((node) => node.matches(":focus-visible") && getComputedStyle(node).outlineStyle !== "none"), `${name}: Back's focus ring`).toBe(true)
  }
  await page.setViewportSize(SIZES[0])
}

test("the round Back is in the window and reached by the keyboard on every screen that has one, at a laptop's and a phone's size", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("backs"), { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  const registrationId = await registrationOf(request, invoiceId)

  await search(page, uniqueLabel("back"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: "What should your name open?" })).toBeVisible()
  await backReady(page, "Links")
  await onStep(page).getByRole("button", { name: "Skip for now" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Save your name code" })).toBeVisible()
  await backReady(page, "Save your name code")
  await savedToReview(page)
  await backReady(page, "Check your order")
  // an order refused for a rate limit shows its own screen, with Back to the search
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "30" }, json: { error: "rate_limited" } }) : route.continue())
  await payButton(page).click()
  await expect(shownScreen(page).getByRole("heading", { name: "Too many attempts" })).toBeVisible()
  await backReady(page, "Too many attempts")
  await page.unroute("**/api/invoice")

  for (const [path, heading] of [["/#/names", "Your names"], ["/#/restore", "Restore with a name code"], ["/#/trademarks", "Trademark owners"]]) {
    await page.goto(path)
    await expect(shownScreen(page).getByRole("heading", { name: heading })).toBeVisible()
    await backReady(page, heading)
  }
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: /is\s+yours/ })).toBeVisible({ timeout: 120_000 })
  await page.goto(`/#/edit/${registrationId}`)
  await expect(shownScreen(page).getByRole("heading", { name: /^Edit links for / })).toBeVisible()
  await backReady(page, "Edit links")
})

// every animation the document runs in this frame, with what runs it
const RUNNING = () => {
  const running = document.getAnimations().map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty}`)
  return running.length ? running : null
}

// A whole-screen swap, a slide along the track, an addition within a step and a change of theme, each recorded frame by frame.
async function moveAround(page: Page): Promise<string[]> {
  await page.goto("/")
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await recordFrames(page, RUNNING)
  await page.locator("body > header").getByRole("link", { name: "Your names" }).click()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await page.locator("a.brand").click()
  // typed into the page, as a new document would lose the frames recorded so far
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("still"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .card")).toBeVisible()
  await page.getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: "What should your name open?" })).toBeVisible()
  await page.locator(".theme-switch").click()
  await page.evaluate(() => new Promise((done) => setTimeout(done, 500)))
  return (await recordedFrames<string[]>(page)).flat()
}

test("asking for less movement turns off every animation and transition the same changes run otherwise", async ({ page }) => {
  // the config asks every page for reduced motion; a reader who has not asked sees the changes move
  await page.emulateMedia({ reducedMotion: "no-preference" })
  const moving = new Set(await moveAround(page))
  for (const name of ["rise", "fade-in", "arrive"]) expect(moving, `animations run for a reader who has not asked: ${[...moving]}`).toContain(name)
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await moveAround(page), "animations run for a reader who asked for less movement").toEqual([])
})

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))

// Screens laid out in view in a frame, a purchase step or a screen of its own: main clips the track's other steps.
const SCREENS_SHOWN = () => {
  const view = document.querySelector("body > main")!.getBoundingClientRect()
  return [...document.querySelectorAll("body > main :is(.screen, .home)")].filter((s) => {
    const box = s.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && box.right > view.left && box.left < view.right && box.bottom > 0 && box.top < innerHeight
  }).length
}

test("a whole-screen swap shows one screen in every frame, never the old one beside the new", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await search(page, uniqueLabel("swap"))
  await toCodeStep(page)
  // the slide to the name code, where two steps share the window by design, ends before the swaps are recorded
  await settled(page)
  await recordFrames(page, SCREENS_SHOWN)
  const swaps: [string, () => Promise<unknown>][] = [
    ["Your names", () => page.locator("body > header").getByRole("link", { name: "Your names" }).click()],
    ["Restore with a name code", () => page.getByRole("link", { name: "Restore with a name code" }).first().click()],
    ["Your names", () => page.goBack()],
    ["Save your name code", () => page.getByRole("button", { name: "Continue checkout" }).first().click()],
  ]
  for (const [heading, swap] of swaps) {
    await swap()
    await expect(shownScreen(page).getByRole("heading", { name: heading })).toBeVisible()
    await settled(page)
  }
  const frames = await recordedFrames<number>(page)
  expect(frames.length, "frames recorded").toBeGreaterThan(swaps.length)
  expect([...new Set(frames)], "screens in the window, frame by frame").toEqual([1])
})
