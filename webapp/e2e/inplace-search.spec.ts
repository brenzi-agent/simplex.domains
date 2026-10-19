import { expect, type Page } from "@playwright/test"
import { recordCuts, takeCuts, takeTransitions } from "./cuts.ts"
import { control, keptNodes, markNodes, registrationOf, startOrder, test, uniqueLabel } from "./helpers.ts"

test.use({ reducedMotion: "no-preference" })
test.beforeEach(async ({ page }) => { await page.addInitScript(recordCuts) })
test.afterEach(async ({ request }) => {
  await control(request, "search", { limitSeconds: 0 })
})

const KEPT = [".search", ".search input", ".search .btn", ".results", "h1"]
const nameField = (page: Page) => page.getByRole("textbox", { name: "Name", exact: true })

async function useCode(page: Page, code: string): Promise<void> {
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.getByRole("button", { name: "Use this code" }).click()
}

test("the search changes in place: a code applied from the popup keeps the box, the typed name and the results", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/")
  await nameField(page).fill("typedname")
  await expect(page.getByText("Press")).toBeVisible()
  await markNodes(page, KEPT)
  await takeTransitions(page)
  await takeCuts(page)
  await useCode(page, code)
  await expect(page.getByText(/^Code applied/)).toBeVisible()
  expect(await keptNodes(page, KEPT)).toEqual(KEPT)
  await expect(nameField(page)).toHaveValue("typedname")
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
})

test("a code applied to a name searched and then removed changes its result in place, with no search sent again", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("insearch")
  await page.goto(`/#/?name=${label}`)
  await expect(page.getByRole("button", { name: "Register", exact: true })).toBeVisible()
  let searches = 0
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/name/")) searches += 1 })
  await markNodes(page, KEPT)
  await takeTransitions(page)
  await takeCuts(page)
  await useCode(page, code)
  await expect(page.getByRole("button", { name: "Register with code" })).toBeVisible()
  await expect(page.locator(".result .chip", { hasText: "Code applied" })).toBeVisible()
  await expect(nameField(page)).toBeFocused()
  await page.locator(".covered").getByText("Remove").click()
  await expect(page.getByRole("button", { name: "Register", exact: true })).toBeVisible()
  await expect(page.getByText("Covered by your code")).toHaveCount(0)
  await expect(nameField(page)).toBeFocused()
  expect(await keptNodes(page, KEPT)).toEqual(KEPT)
  await expect(nameField(page)).toHaveValue(label)
  expect(searches).toBe(0)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
})

test("a search paused by a rate limit keeps the box and the results, and searches the name once the wait is over", async ({ page, request }) => {
  await page.goto("/")
  await control(request, "search", { limitSeconds: 2 })
  await nameField(page).fill(uniqueLabel("inpause"))
  await markNodes(page, KEPT)
  await takeTransitions(page)
  await takeCuts(page)
  await nameField(page).press("Enter")
  await expect(page.locator("b[aria-hidden=true]", { hasText: /Try again in \d+ seconds?/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Search" })).toBeDisabled()
  await control(request, "search", { limitSeconds: 0 })
  await expect(page.getByRole("button", { name: "Register", exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("button", { name: "Search" })).toBeEnabled()
  expect(await keptNodes(page, KEPT)).toEqual(KEPT)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
})

test("a retarget banner corrected once its order is read crosses over in place", async ({ page, request }) => {
  const label = uniqueLabel("inretarget")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: 120_000 })
  const registrationId = await registrationOf(request, invoiceId)
  await page.getByRole("button", { name: "Take a code" }).click()
  await expect(page.getByRole("heading", { name: "Here is a code instead" })).toBeVisible()
  let answer!: () => void
  const marked = new Promise<void>((resolve) => { answer = resolve })
  await page.route(`**/api/invoice/${invoiceId}`, async (route) => {
    await marked
    await route.continue()
  })
  await page.goto(`/#/?retarget=${registrationId}`)
  await expect(page.getByText("Your payment is kept")).toBeVisible()
  const kept = [...KEPT, ".banner-slot"]
  await markNodes(page, kept)
  await takeTransitions(page)
  await takeCuts(page)
  answer()
  await expect(page.getByText("Your payment already became a code.")).toBeVisible()
  await expect(page.locator(".banner-slot .banner:not(.outgoing *)")).toHaveCount(1)
  expect(await keptNodes(page, kept)).toEqual(kept)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
})
