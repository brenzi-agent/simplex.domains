import { expect, type Locator, type Page } from "@playwright/test"
import {
  CODE_HEADING, contactLink, control, LINKS_HEADING, onStep, payButton, recordedFrames, recordFrames, registrationOf, savedToReview, search, startOrder, test, toReview, uniqueLabel,
} from "./helpers.ts"

const SIZES = [{ width: 1280, height: 800 }, { width: 390, height: 844 }]
const BACK_PX = 40

// Back sits wholly in the window as a 40 px circle at each size, and is the first stop after the header for the keyboard.
async function backReady(page: Page, name: string): Promise<void> {
  const back = onStep(page).locator(".back")
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
  await expect(onStep(page).getByRole("heading", { name: "Too many attempts" })).toBeVisible()
  await backReady(page, "Too many attempts")
  await page.unroute("**/api/invoice")

  for (const [path, heading] of [["/#/names", "Your names"], ["/#/restore", "Restore with a name code"], ["/#/trademarks", "Trademark owners"]]) {
    await page.goto(path)
    await expect(onStep(page).getByRole("heading", { name: heading })).toBeVisible()
    await backReady(page, heading)
  }
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: /is\s+yours/ })).toBeVisible({ timeout: 120_000 })
  await page.goto(`/#/edit/${registrationId}`)
  await expect(onStep(page).getByRole("heading", { name: /^Edit links for / })).toBeVisible()
  await backReady(page, "Edit links")
})

// every animation the document runs in this frame, with what runs it
const RUNNING = () => {
  const running = document.getAnimations().map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty}`)
  return running.length ? running : null
}

// Whole-screen swaps, a purchase step's among them, an addition within a step and a change of theme, each recorded frame by frame.
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
  // the switch's transitions have started two frames on, and are recorded until they end
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await settled(page)
  return (await recordedFrames<string[]>(page)).flat()
}

test("asking for less movement turns off every animation and transition the same changes run otherwise", async ({ page }) => {
  // the config asks every page for reduced motion; a reader who has not asked sees the changes move
  await page.emulateMedia({ reducedMotion: "no-preference" })
  const moving = new Set(await moveAround(page))
  for (const name of ["rise", "arrive"]) expect(moving, `animations run for a reader who has not asked: ${[...moving]}`).toContain(name)
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await moveAround(page), "animations run for a reader who asked for less movement").toEqual([])
})

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))

// Screens laid out in view in a frame.
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
  await expect(page.getByRole("button", { name: "Register" })).toBeEnabled()
  await settled(page)
  await recordFrames(page, SCREENS_SHOWN)
  const swaps: [string, () => Promise<unknown>][] = [
    [LINKS_HEADING, () => page.getByRole("button", { name: "Register" }).click()],
    [CODE_HEADING, () => onStep(page).getByRole("button", { name: "Skip for now" }).click()],
    ["Your names", () => page.locator("body > header").getByRole("link", { name: "Your names" }).click()],
    ["Restore with a name code", () => page.getByRole("link", { name: "Restore with a name code" }).first().click()],
    ["Your names", () => page.goBack()],
    [CODE_HEADING, () => page.getByRole("button", { name: "Continue checkout" }).first().click()],
  ]
  for (const [heading, swap] of swaps) {
    await swap()
    await expect(onStep(page).getByRole("heading", { name: heading })).toBeVisible()
    await settled(page)
  }
  const frames = await recordedFrames<number>(page)
  expect(frames.length, "frames recorded").toBeGreaterThan(swaps.length)
  expect([...new Set(frames)], "screens in the window, frame by frame").toEqual([1])
})

test("a redraw that only changes the words of what is shown, as a rate limit's wait ending, replays no arrival", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await search(page, uniqueLabel("rearrive"))
  await toReview(page)
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }) : route.continue())
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: "Too many attempts" })).toBeVisible()
  await settled(page)
  await recordFrames(page, RUNNING)
  // the wait's end draws the screen again, its notice saying the same thing in other words
  await expect(onStep(page).getByRole("button", { name: "Try again" })).toBeEnabled()
  await expect(onStep(page).locator(".notice")).toHaveText(/Nothing was charged/)
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  expect((await recordedFrames<string[]>(page)).flat(), "animations run as the wait ends").not.toContain("arrive")
})

// longer than an arrival, as a real preview takes
const PREVIEW_DELAY_MS = 700

test("a link's profile takes its placeholder's place as it is, rather than arriving again", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.route("**/api/link/preview", async (route) => {
    await new Promise((done) => setTimeout(done, PREVIEW_DELAY_MS))
    await route.fulfill({ json: { type: "address", displayName: "Late profile", image: null } })
  })
  await search(page, uniqueLabel("inplace"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await settled(page)
  // each frame's opacity of the profile drawn in the field, once it is there
  await recordFrames(page, () => {
    const card = document.querySelector("body > main .link-field .entity:not(.skeleton)")
    return card ? getComputedStyle(card).opacity : null
  })
  await onStep(page).getByRole("textbox", { name: "Contact address" }).fill(contactLink("IP"))
  // the field left while its profile is asked for shows the placeholder
  await onStep(page).getByRole("textbox", { name: "Channel" }).focus()
  await expect(onStep(page).locator(".link-field .entity.skeleton")).toBeVisible()
  await expect(onStep(page).locator(".link-field .entity", { hasText: "Late profile" })).toBeVisible()
  await settled(page)
  const frames = await recordedFrames<string>(page)
  expect(frames.length, "frames with the profile").toBeGreaterThan(0)
  expect([...new Set(frames)], "the profile's opacity, frame by frame").toEqual(["1"])
})

// each frame's theme tokens beside the colours of the controls drawn with them
const CONTROL_COLOURS = () => {
  const root = getComputedStyle(document.documentElement)
  const button = getComputedStyle(document.querySelector("body > main .btn")!)
  const back = getComputedStyle(document.querySelector("body > main .back")!)
  return [
    [root.getPropertyValue("--primary"), button.backgroundColor],
    [root.getPropertyValue("--primary-ink"), button.color],
    [root.getPropertyValue("--surface"), back.backgroundColor],
  ]
}

test("a switch of theme moves the controls' colours with the page's, frame by frame, both ways", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await search(page, uniqueLabel("theme"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await settled(page)
  for (const theme of ["dark", "light"]) {
    await recordFrames(page, CONTROL_COLOURS)
    await page.locator(".theme-switch").click()
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    await settled(page)
    const frames = await recordedFrames<string[][]>(page)
    const apart = frames.flat().filter(([token, drawn]) => token !== drawn)
    expect(frames.length, `frames recorded switching to ${theme}`).toBeGreaterThan(2)
    expect(apart, `controls apart from their tokens switching to ${theme}`).toEqual([])
  }
})

const PRESSED = "brightness(0.94)"

// a button's filter while a mouse holds it down, released away from it so it does not click
async function pressedLook(page: Page, button: Locator): Promise<string> {
  await button.hover()
  await page.mouse.down()
  const filter = await button.evaluate((node) => getComputedStyle(node).filter)
  await page.mouse.move(0, 0)
  await page.mouse.up()
  return filter
}

test("a button held down under a mouse shows its press over its hover, a primary and a quiet one", async ({ page }) => {
  await search(page, uniqueLabel("press"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  const skip = onStep(page).getByRole("button", { name: "Skip for now" })
  expect(await pressedLook(page, skip), "Skip for now held down").toBe(PRESSED)
  await skip.click()
  await expect(onStep(page).getByRole("heading", { name: "Save your name code" })).toBeVisible()
  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").click()
  expect(await pressedLook(page, page.getByRole("button", { name: "Keep them" })), "Keep them held down").toBe(PRESSED)
})
