import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { recordCuts, takeCuts, takeTransitions } from "./cuts.ts"
import { control, fades, keptNodes, markNodes, MOCK, REGISTRATION_MS, startOrder, test, uniqueLabel } from "./helpers.ts"

test.use({ reducedMotion: "no-preference" })
test.beforeEach(async ({ page }) => { await page.addInitScript(recordCuts) })

async function registerWithCode(page: Page, request: APIRequestContext, prefix: string): Promise<void> {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await page.getByRole("button", { name: "Use this code" }).click()
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(uniqueLabel(prefix))
  await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with code" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByText("I have saved my code").click()
  await page.getByRole("button", { name: "Register", exact: true }).click()
}

test("registering changes in place: the steps, countdown and transactions keep their nodes through each phase", async ({ page, request }) => {
  await registerWithCode(page, request, "inplace")
  await page.locator(".stage.active", { hasText: "Committing" }).waitFor({ timeout: REGISTRATION_MS })
  const kept = [".track", ".stage:nth-child(1)", ".countdown", ".txs", ".summary", "h1"]
  await markNodes(page, kept)
  await takeTransitions(page)
  await takeCuts(page)
  await page.locator(".stage.active", { hasText: "Waiting" }).waitFor({ timeout: REGISTRATION_MS })
  expect(await keptNodes(page, kept)).toEqual(kept)
  expect(await page.evaluate(() => [...document.querySelectorAll("body > main .stage")].map((s) => s.className))).toEqual(["stage done", "stage active", "stage"])
  await page.locator(".stage.active", { hasText: "Registering" }).waitFor({ timeout: REGISTRATION_MS })
  expect(await keptNodes(page, kept)).toEqual(kept)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
})

const TIMELINE_STEP_MS = 10

test("a new screen is a page change: registered right behind registering replaces it in one transition and its heading takes focus", async ({ page, request }) => {
  await page.route("**/api/registration/*", async (route) => {
    const res = await route.fetch()
    const view = await res.json() as { id: string; phase: string }
    if (view.phase === "registering") {
      await expect.poll(async () => (await (await request.get(`${MOCK}/api/registration/${view.id}?seenPhase=registering`)).json()).phase, { timeout: REGISTRATION_MS }).toBe("registered")
    }
    await route.fulfill({ response: res })
  })
  await registerWithCode(page, request, "newscreen")
  await page.locator(".stage.active", { hasText: "Committing" }).waitFor({ timeout: REGISTRATION_MS })
  await takeTransitions(page)
  await takeCuts(page)
  await page.evaluate((step) => {
    const w = window as unknown as { __leaving: number; __heights: number[] }
    w.__leaving = 0
    w.__heights = []
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof Element && n.classList.contains("page-leaving")) w.__leaving += 1
      if (w.__leaving !== 1 || w.__heights.length) return
      const block = document.querySelector("body > main:not(.pending) > .live")!
      const motion = document.getAnimations().filter((a) => a.playState !== "finished")
      const end = Math.max(...motion.filter((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => "height" in k)).map((a) => Number(a.effect!.getComputedTiming().endTime)))
      const from = motion.map((a) => { a.pause(); return Number(a.currentTime) })
      for (let t = 0; t <= end; t += step) {
        motion.forEach((a, i) => { a.currentTime = from[i] + t })
        w.__heights.push(Math.round(block.getBoundingClientRect().height))
      }
      motion.forEach((a, i) => { a.currentTime = from[i]; a.play() })
    }).observe(document.body, { childList: true })
  }, TIMELINE_STEP_MS)
  await expect(page.getByRole("heading", { name: /is yours$/ })).toBeVisible({ timeout: REGISTRATION_MS })
  if (await fades(page)) {
    await expect(page.locator(".page-leaving")).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __leaving: number }).__leaving)).toBe(1)
    const heights = await page.evaluate(() => (window as unknown as { __heights: number[] }).__heights)
    const [low, high] = [Math.min(heights[0], heights.at(-1)!), Math.max(heights[0], heights.at(-1)!)]
    expect(heights.filter((h) => h < low - 1 || h > high + 1), `the block's heights through the change: ${heights.join(" ")}`).toEqual([])
  } else {
    await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))
    expect(await takeTransitions(page)).toHaveLength(1)
  }
  await expect(page.locator("body > main h1")).toBeFocused()
  expect(await takeCuts(page)).toEqual([])
})

test("a cancelled invoice the service still shows open takes a late part payment in place: only its sentence fades", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("stillpart"), { method: "btc" })
  await control(request, "search", { cancelStillOpen: true })
  await page.getByText("Cancel this invoice").click()
  await expect(page.getByRole("heading", { name: "Invoice cancelled" })).toBeVisible()
  await control(request, "search", { cancelStillOpen: false })
  const kept = [".status h1", ".status .orb", ".status .actions .btn", ".status .ref"]
  await markNodes(page, kept)
  await takeTransitions(page)
  await takeCuts(page)
  await control(request, `partial/${invoiceId}`)
  await expect(page.getByText(/Part of the payment arrived; quote the reference below to support/)).toBeVisible()
  expect(await keptNodes(page, kept)).toEqual(kept)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
})

test("the order's rate-limit notice gives screen readers its wait once, in its live region, while the countdown runs", async ({ page }) => {
  await startOrder(page, uniqueLabel("srhold"), { method: "btc" })
  await page.route("**/cancel", (route) => route.fulfill({ status: 429, headers: { "retry-after": "20" }, json: { error: "rate_limited" } }))
  const copy = page.locator("body > main .sr-only", { hasText: "Try again in" })
  await expect(copy).toHaveCount(0)
  await page.getByText("Cancel this invoice").click()
  const region = page.locator("body > main [role=status]", { hasText: "Too many attempts" })
  await expect(region).toBeVisible()
  await expect(copy).toHaveText([/^The invoice is still open\. Try again in \d+ seconds\.$/])
  await expect(region.locator(".sr-only")).toHaveCount(1)
  const count = region.locator("[aria-hidden=true] .count")
  const left = () => count.evaluate((n) => Number([...n.querySelectorAll<HTMLElement>(".digits:not(.outgoing) .roll")].map((c) => c.dataset.ch).join("")))
  const first = await left()
  expect(first).toBeGreaterThan(1)
  await expect.poll(left).toBeLessThan(first)
})
