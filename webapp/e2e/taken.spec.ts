import { expect } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { labelHash } from "../src/crypto/registration.ts"
import { checksumAddress, hex } from "../src/crypto/wallet.ts"
import { codeField, control, mockRegistration, onStep, REGISTRATION_MS, registrationOf, searchName, shot, startOrder, test, uniqueLabel, waitRegistered } from "./helpers.ts"

test("a name taken first moves the paid order to another name, owned by the same code", async ({ page, request }) => {
  const label = uniqueLabel("tk")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: REGISTRATION_MS })
  await expect(page.getByText(/^Choose another name of up to \$100\.00, .* or take a code for names of \d+ or more letters, for 2 years \+ 30 days\.$/)).toBeVisible()
  // the two ways forward are stacked, the move to another name first
  const [other, code] = [page.getByRole("button", { name: "Choose another name" }), page.getByRole("button", { name: "Take a code" })]
  // the main button centred, the other way under it
  const [otherBox, codeBox] = [(await other.boundingBox())!, (await code.boundingBox())!]
  expect(otherBox.x + otherBox.width / 2).toBeCloseTo(codeBox.x + codeBox.width / 2, 0)
  expect(otherBox.y + otherBox.height).toBeLessThanOrEqual(codeBox.y)
  await expect(page.getByText(`Reference ${invoiceId}`)).toBeVisible()
  await shot(page, "N8-taken")

  await page.getByRole("button", { name: "Choose another name" }).click()
  await expect(page.getByText(/Your payment is kept: \$100\.00/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Invest to claim your name" })).toHaveCount(0)
  const next = uniqueLabel("tk2")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Covered by your payment")).toBeVisible()
  await shot(page, "N8a-another-name")
  // a rate-limited move holds its button for the wait
  await page.route("**/name", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }) : route.continue())
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await expect(page.getByRole("button", { name: "Register with your payment" })).toBeDisabled()
  // searching again during the wait says searching is paused, rather than sending anything
  await page.getByLabel("Name", { exact: true }).press("Enter")
  const paused = page.locator(".answer .line", { hasText: "Searching is paused" })
  await expect(paused).toBeVisible()
  await page.unroute("**/name")
  await expect(paused).toHaveCount(0, { timeout: 10_000 })
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await page.waitForURL(/\?order=/)
  await waitRegistered(page, next)
  const answer = await searchName(request, next)
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
})

// a wait on moving the payment that ends while the search gone back to is still out, and that search's answer
const MOVE_WAIT_S = 3
const SEARCH_RTT_MS = 5_000

test("a wait on moving the payment that ends while Back checks the name again sends no second search", async ({ page, request }) => {
  const label = uniqueLabel("tw")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: REGISTRATION_MS })
  await page.getByRole("button", { name: "Choose another name" }).click()
  const next = uniqueLabel("tw2")
  // an order this browser made for the name before, which has Back check the name again
  await page.evaluate(({ label, hash }) => localStorage.setItem("simplex-names:order:reg-before", JSON.stringify({
    registrationId: "reg-before", invoiceId: null, label, ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    contact: "", channel: "", method: "code", paid: 0, years: 2, secret: "0x01", tld: "simplex", createdAt: new Date().toISOString(),
    request: { labelHash: hash, length: label.length, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", commitment: "0x01", sealed: "sealed" },
  })), { label: next, hash: hex(labelHash(next)) })
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Covered by your payment")).toBeVisible()
  await page.route("**/name", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": String(MOVE_WAIT_S) }, json: { error: "rate_limited" } }) : route.continue())
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  let searches = 0
  await page.route("**/api/name/**", async (route) => {
    searches++
    await new Promise((answered) => setTimeout(answered, SEARCH_RTT_MS))
    await route.continue()
  })
  await page.locator("body > footer").getByRole("link", { name: "Trademark owners" }).click()
  await expect(page.getByRole("heading", { name: "Trademark owners" })).toBeVisible()
  await page.goBack()
  await expect(page.locator(".answer .line", { hasText: "Checking the name…" })).toBeVisible()
  await expect(page.getByText("Covered by your payment")).toBeVisible({ timeout: 2 * SEARCH_RTT_MS })
  expect(searches, "searches sent since Back").toBe(1)
})

test("a name taken first can become a code instead, kept under Your names", async ({ page, request }) => {
  const label = uniqueLabel("tc")
  const { invoiceId } = await startOrder(page, label, { method: "xmr" })
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: REGISTRATION_MS })
  await page.getByRole("button", { name: "Take a code" }).click()
  await expect(page.getByRole("heading", { name: "Here is a code instead" })).toBeVisible()
  const code = (await page.locator(".outcome .code-text").textContent())!.trim()
  expect(code).toMatch(/^SN8-/)
  await shot(page, "N8b-code-instead")

  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: code }).locator(".chip")).toHaveText("Unused")
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText("Code taken")
})

test("a failed registration is retried without paying again, and another tab follows the retry", async ({ page, request }) => {
  const label = uniqueLabel("fl")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `fail/${await registrationOf(request, invoiceId)}`)
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: 60_000 })
  await shot(page, "N9-failed")
  const other = await page.context().newPage()
  await other.goto(`/?order=${invoiceId}`)
  await expect(other.getByRole("heading", { name: "Paid, not registered" })).toBeVisible()
  // a rate-limited retry holds its button for the wait
  await page.route("**/retry", (route) => route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await page.getByRole("button", { name: "Try again" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again" })).toBeDisabled()
  await page.unroute("**/retry")
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled({ timeout: 10_000 })
  // a keyboard user is back on the button once the wait is over
  await expect(page.getByRole("button", { name: "Try again" })).toBeFocused()
  await page.getByRole("button", { name: "Try again" }).click()
  // the button is gone from the redrawn page, so focus goes to its heading at once
  await expect(page.locator("main h1")).toBeFocused({ timeout: 2_000 })
  await expect(other.getByRole("heading", { name: "Paid, not registered" })).toHaveCount(0)
  await waitRegistered(page, label)
  await waitRegistered(other, label)
})

// a chain that fails each transaction before it goes out, as an RPC provider down for a while, and a look half way through
const UNSENT_S = 4
const UNSENT_CHECK_MS = UNSENT_S * 1000 / 2
test("a chain that sends nothing for a moment keeps the order where it was, then registers it", async ({ page, request }) => {
  const label = uniqueLabel("ns")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  try {
    await control(request, "search", { unsentSeconds: UNSENT_S })
    await control(request, `settle/${invoiceId}`)
    await page.waitForTimeout(UNSENT_CHECK_MS)
    // tried again every few seconds, the commit neither fails nor goes back to the queue
    expect((await mockRegistration(request, invoiceId)).phase).toBe("committing")
    await expect(page.locator(".stage.active", { hasText: "Committing" })).toBeVisible()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
  await waitRegistered(page, label)
})

test("a chain that sends nothing for longer than its resends fails the order in plain words, and Try again sends it", async ({ page, request }) => {
  test.setTimeout(240_000)
  const label = uniqueLabel("nd")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  try {
    await control(request, "search", { unsentSeconds: 120 })
    await control(request, `settle/${invoiceId}`)
    await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText("The blockchain did not answer")).toBeVisible()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
  await page.getByRole("button", { name: "Try again" }).click()
  await waitRegistered(page, label)
})

test("a late payment to a replaced invoice is kept by a restored browser after the order moved to another name", async ({ page, browser, request }) => {
  const label = `${uniqueLabel("adopt")}-${"long-name".repeat(4)}`
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, "take", { label })
  await control(request, `settle/${second}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: REGISTRATION_MS })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole("button", { name: "Choose another name" }).click()
  const next = uniqueLabel("adopt2")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await page.waitForURL(/\?order=/)
  await waitRegistered(page, next)

  const other = await browser.newContext()
  const restored = await other.newPage()
  // the order moved to the other name and registered it; its page takes the name code and comes back to it
  await restored.goto(`/?order=${second}`)
  await restored.getByRole("button", { name: "Restore with your name code" }).click()
  await codeField(restored).fill(ownerCode)
  await onStep(restored).getByRole("button", { name: "Add to Your names" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await waitRegistered(restored, next)
  await control(request, `partial/${invoiceId}`)
  await restored.goto(`/?order=${invoiceId}`)
  await expect(restored.getByText(/BTC arrived, which is not the full amount/)).toBeVisible()
  await restored.goto("/#/names")
  await expect(restored.locator(".list-row:visible", { hasText: `${label}.simplex` })).toContainText("Part of the payment arrived")
  await restored.goto(`/?order=${invoiceId}`)
  await restored.getByRole("button", { name: "Open the new invoice" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await other.close()

  // the name someone else registered, searched at phone width, wraps inside its card
  await page.goto(`/#/?name=${label}`)
  await expect(page.getByText("Taken", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

