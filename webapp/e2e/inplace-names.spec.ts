import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { recordCuts, takeCuts, takeTransitions } from "./cuts.ts"
import { EDIT_RETRY_MS } from "../src/screens/names.ts"
import { control, keptNodes, markNodes, registrationOf, settle, startOrder, test, uniqueLabel } from "./helpers.ts"

test.use({ reducedMotion: "no-preference" })
test.beforeEach(async ({ page }) => { await page.addInitScript(recordCuts) })

// a retry's wait and the read it starts
const RETRY_ROUND_MS = EDIT_RETRY_MS + 1000
const codeOf = async (request: APIRequestContext) => (await control(request, "code", { minLength: 6 }) as { code: string }).code
const store = (code: string) => localStorage.setItem(`simplex-names:code:${code}`, JSON.stringify({ code, minLength: 6, years: 2, addedAt: new Date().toISOString() }))

async function openWithCodes(page: Page, codes: string[]): Promise<void> {
  await page.goto("/#/names")
  for (const code of codes) await page.evaluate(store, code)
  await page.reload()
  await expect(page.locator(".code-row")).toHaveCount(codes.length)
  await expect(page.locator(".row-item.entering")).toHaveCount(0)
}

test("Your names changes in place: rows another tab leaves alone keep their nodes", async ({ page, context, request }) => {
  const [first, second, third] = [await codeOf(request), await codeOf(request), await codeOf(request)]
  await openWithCodes(page, [first, second])
  await expect(page.locator(".code-row .chip", { hasText: "Unused" })).toHaveCount(2)
  const kept = [".code-row:nth-child(1)", ".code-row:nth-child(2)", ".empty-list", "h1", ".toolbar"]
  await markNodes(page, kept)
  await takeTransitions(page)
  await takeCuts(page)
  const other = await context.newPage()
  await other.goto("/#/names")
  await page.bringToFront()
  await other.evaluate(store, third)
  await expect(page.locator(".code-row")).toHaveCount(3)
  await expect(page.locator(".code-row").nth(2)).toContainText(third)
  await expect(page.locator(".code-row.entering")).toHaveCount(0)
  await settle(page)
  expect(await keptNodes(page, kept)).toEqual(kept)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
  await other.close()
})

test("Your names takes a row away in place: the rows left keep their nodes, and the last one gone brings the empty note", async ({ page, context, request }) => {
  const [first, second] = [await codeOf(request), await codeOf(request)]
  await openWithCodes(page, [first, second])
  await markNodes(page, [".code-row:nth-child(2)", "h1"])
  await takeTransitions(page)
  await takeCuts(page)
  const other = await context.newPage()
  await other.goto("/#/names")
  await page.bringToFront()
  await other.evaluate((code) => localStorage.removeItem(`simplex-names:code:${code}`), first)
  await expect(page.locator(".code-row:not(.outgoing)")).toHaveCount(1)
  await expect(page.locator(".code-row.outgoing")).toHaveCount(0)
  expect(await keptNodes(page, [".code-row:nth-child(1)", "h1"])).toEqual([".code-row:nth-child(1)", "h1"])
  await other.evaluate((code) => localStorage.removeItem(`simplex-names:code:${code}`), second)
  await expect(page.locator(".panel", { hasText: "Codes" }).locator(".empty-list")).toHaveText("No codes in this browser yet.")
  await expect(page.getByText("Forget everything in this browser")).toHaveCount(0)
  await settle(page)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
  await other.close()
})

test("an order another browser replaced with a new invoice crosses over to it in its own row's place", async ({ page, browser, request }) => {
  const [older, newer] = [uniqueLabel("replold"), uniqueLabel("replnew")]
  const first = await startOrder(page, older, { method: "btc" })
  const second = await startOrder(page, newer, { method: "btc" })
  const other = await browser.newContext({ reducedMotion: "no-preference" })
  await other.addInitScript(recordCuts)
  const restored = await other.newPage()
  for (const { invoiceId, ownerCode } of [first, second]) {
    await restored.goto("/#/restore")
    await restored.getByLabel("Name code").fill(ownerCode)
    await restored.getByRole("button", { name: "Restore" }).click()
    await restored.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  }
  await restored.goto("/#/names")
  const rows = restored.locator(".row-item:not(.outgoing)")
  await expect(rows.locator(".main b")).toHaveText([`${newer}.simplex`, `${older}.simplex`])
  await expect(rows.locator(":scope > .live > .chip")).toHaveText(["Waiting for payment", "Waiting for payment"])
  await settle(restored)
  await markNodes(restored, [".row-item:nth-child(1)", "h1"])
  await takeTransitions(restored)
  await takeCuts(restored)
  await control(request, `expire/${first.invoiceId}`)
  await page.goto(`/?order=${first.invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== first.invoiceId)
  const replacement = new URL(page.url()).searchParams.get("order")!
  await expect(restored.locator(`.row-item[data-key="${await registrationOf(request, replacement)}"]`)).toHaveCount(1, { timeout: 30_000 })
  await expect(rows).toHaveCount(2)
  await expect(rows.locator(".main b")).toHaveText([`${newer}.simplex`, `${older}.simplex`])
  await settle(restored)
  expect(await keptNodes(restored, [".row-item:nth-child(1)", "h1"])).toEqual([".row-item:nth-child(1)", "h1"])
  expect(await takeTransitions(restored)).toEqual([])
  expect(await takeCuts(restored)).toEqual([])
  await other.close()
})

test("an order replaced on its own page while Your names was left is not listed again from what was read before", async ({ page, request }) => {
  const label = uniqueLabel("reopen")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await page.locator("nav a[data-nav=names]").click()
  const row = page.locator(".row-item:not(.outgoing)", { hasText: `${label}.simplex` })
  await expect(row.locator(":scope > .live > .chip")).toHaveText("Waiting for payment")
  await row.getByText("Open", { exact: true }).click()
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const replacement = await registrationOf(request, new URL(page.url()).searchParams.get("order")!)
  await page.locator("nav a[data-nav=names]").click()
  await expect(page.locator(".row-item:not(.outgoing)", { hasText: `${label}.simplex` })).toHaveCount(1)
  await expect(row).toHaveAttribute("data-key", replacement)
  await expect(row.locator(":scope > .live > .chip")).toHaveText("Waiting for payment")
  await settle(page)
  await expect(page.locator(".row-item:not(.outgoing)", { hasText: `${label}.simplex` })).toHaveCount(1)
})

test("Forget everything asks and answers in place: the question crosses over the link, the rows fade out and the notes come in", async ({ page, request }) => {
  await openWithCodes(page, [await codeOf(request)])
  await markNodes(page, ["h1", ".toolbar"])
  await takeTransitions(page)
  await takeCuts(page)
  await page.getByText("Forget everything in this browser").click()
  await expect(page.getByRole("button", { name: "Keep them" })).toBeFocused()
  await page.getByRole("button", { name: "Forget everything" }).click()
  await expect(page.locator(".row-item")).toHaveCount(0)
  await expect(page.locator(".empty-list")).toHaveCount(2)
  await expect(page.getByRole("heading", { name: "Your names" })).toBeFocused()
  await settle(page)
  expect(await keptNodes(page, ["h1", ".toolbar"])).toEqual(["h1", ".toolbar"])
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
})

const LONG_LIST = 6
test("forgetting everything from the foot of a long list on a phone keeps the page where it is as focus goes to the heading", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openWithCodes(page, await Promise.all(Array.from({ length: LONG_LIST }, () => codeOf(request))))
  await page.getByText("Forget everything in this browser").click()
  await page.getByRole("button", { name: "Forget everything" }).scrollIntoViewIfNeeded()
  await settle(page)
  const heading = page.getByRole("heading", { name: "Your names" })
  const headingFoot = await heading.evaluate((n) => n.getBoundingClientRect().bottom + scrollY)
  // the parts hold their heights while they ease, so only a focus that scrolls moves the page as the button is pressed
  const [before, pressed] = await page.evaluate(() => {
    const before = scrollY
    ;[...document.querySelectorAll<HTMLElement>("body > main .btn")].find((b) => b.textContent?.trim() === "Forget everything")!.click()
    return [before, scrollY]
  })
  expect(before, "the heading is scrolled out of view").toBeGreaterThan(headingFoot)
  await expect(heading).toBeFocused()
  expect(pressed, "the page as focus goes to the heading").toBe(before)
  await settle(page)
  expect(await takeCuts(page)).toEqual([])
})

test("a restore refused for the code, and refused again for another, changes in place", async ({ page, request }) => {
  await page.goto("/#/restore")
  await expect(page.getByLabel("Name code")).toBeFocused()
  const kept = ["h1", ".panel-sec", "input", ".summary"]
  await markNodes(page, kept)
  await takeTransitions(page)
  await takeCuts(page)
  await page.getByLabel("Name code").fill("SN-not-a-code")
  await page.getByRole("button", { name: "Restore" }).click()
  await expect(page.locator(".verdict.bad")).toContainText("This code is not valid")
  await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled()
  await page.getByLabel("Name code").fill(await codeOf(request))
  await expect(page.locator(".verdict")).toHaveCount(0)
  await page.getByRole("button", { name: "Restore" }).click()
  await expect(page.locator(".verdict.bad")).toContainText("This is a prepaid code")
  await settle(page)
  expect(await keptNodes(page, kept)).toEqual(kept)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
})

test("an edit page that cannot read its name retries in place, and stops retrying once left", async ({ page }) => {
  const registrationId = "reg-inplace-edit"
  await page.goto("/#/trademarks")
  await page.evaluate((id) => localStorage.setItem(`simplex-names:order:${id}`, JSON.stringify({
    registrationId: id, invoiceId: null, label: "inplaceedit", ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    contact: "", channel: "", method: "code", paid: 0, years: 2, secret: "0x01", tld: "simplex", createdAt: new Date().toISOString(),
    request: { labelHash: "0x4f1b", length: 11, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", commitment: "0x01", sealed: "sealed" },
  })), registrationId)
  let reads = 0
  await page.route(`**/api/registration/${registrationId}*`, (route) => { reads += 1; return route.fulfill({ status: 503, json: { error: "unavailable" } }) })
  await page.goto(`/#/edit/${registrationId}`)
  await expect(page.getByText("The name could not be read now")).toBeVisible()
  const kept = ["h1", ".notice", ".btn"]
  await markNodes(page, kept)
  await takeTransitions(page)
  await takeCuts(page)
  const answered = page.waitForResponse((r) => r.url().includes(`/api/registration/${registrationId}`))
  await page.getByRole("button", { name: "Try again" }).click()
  await answered
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled()
  await settle(page)
  expect(await keptNodes(page, kept)).toEqual(kept)
  expect(await takeTransitions(page)).toEqual([])
  expect(await takeCuts(page)).toEqual([])
  const shown = reads
  await expect.poll(() => reads, { timeout: 8000 }).toBeGreaterThan(shown)
  await page.goto("/#/trademarks")
  const left = reads
  await page.waitForTimeout(RETRY_ROUND_MS)
  expect(reads).toBe(left)
})
