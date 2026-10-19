import { expect, type Page } from "@playwright/test"
import { control, search, startOrder, test, uniqueLabel } from "./helpers.ts"

// EIP-55's own example, and the same wallet with one letter's case changed
const APP_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const DAMAGED_WALLET = "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed"

async function showOwnerCode(page: Page, label: string): Promise<void> {
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("heading", { name: "Save your name code" })).toBeVisible()
}

const OLD = "data-old"
const markDrawn = (page: Page) => page.locator("main").evaluate((n, attr) => n.setAttribute(attr, ""), OLD)

async function redrawnInPlace(page: Page, invoiceId: string, redraw: () => Promise<void>): Promise<void> {
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/invoice/${invoiceId}` && !r.url().includes("?"))
  await redraw()
  await read
  await expect(page.locator("main[aria-busy]")).toHaveCount(0)
  await expect(page.locator(`main[${OLD}]`)).toHaveCount(1)
}

// another tab writes the same record again with a space more or less, which this tab hears as a change
async function touchRecord(other: Page, key: string): Promise<void> {
  await other.evaluate((k) => {
    const value = localStorage.getItem(k)!
    localStorage.setItem(k, value.endsWith(" ") ? value.trimEnd() : `${value} `)
  }, key)
}

// a redraw of the same screen moves focus only back to the control it was on, which is gone here
const focusOnPage = (page: Page) => expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true)

test("removing a pending name code leaves focus on the page, so a second Enter removes nothing", async ({ page }) => {
  const older = uniqueLabel("rmold")
  const newer = uniqueLabel("rmnew")
  await showOwnerCode(page, older)
  await showOwnerCode(page, newer)
  await page.goto("/#/names")
  const newest = page.locator(".row-item").first()
  await expect(newest).toContainText(`${newer}.simplex`)
  await newest.getByText("Remove", { exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".row-item", { hasText: `${newer}.simplex` })).toHaveCount(0)
  await focusOnPage(page)
  await page.keyboard.press("Enter")
  await expect(page.locator(".row-item", { hasText: `${older}.simplex` })).toHaveCount(1)
})

test("Your names keeps focus in its row when another tab adds a row above it", async ({ page }) => {
  const label = uniqueLabel("rowfocus")
  await startOrder(page, label, { method: "btc" })
  await page.goto("/#/names")
  const row = page.locator(".row-item", { hasText: `${label}.simplex` })
  await row.getByText("Open", { exact: true }).focus()
  await markDrawn(page)
  const other = await page.context().newPage()
  await showOwnerCode(other, uniqueLabel("above"))
  await expect(page.locator(".row-item").first()).toContainText("Checkout not finished")
  await expect(page.locator(`main[${OLD}]`)).toHaveCount(1)
  await expect(row.getByText("Open", { exact: true })).toBeFocused()
  await other.close()
})

test("an order's page keeps focus when another tab changes the order", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("ordfocus"), { method: "btc" })
  const key = await page.evaluate((id) => Object.keys(localStorage).find((k) => k.startsWith("simplex-names:order:") && localStorage.getItem(k)!.includes(id))!, invoiceId)
  const other = await page.context().newPage()
  await other.goto("/")
  await page.getByRole("button", { name: "Cancel this invoice" }).focus()
  await markDrawn(page)
  await redrawnInPlace(page, invoiceId, () => touchRecord(other, key))
  await expect(page.getByText("Loading…")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Cancel this invoice" })).toBeFocused()
  await other.close()
})

test("a name typed but not searched stays when a code is applied from the popup", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await search(page, uniqueLabel("shown"))
  await expect(page.locator(".result")).toBeVisible()
  const typed = uniqueLabel("typed")
  await page.getByLabel("Name", { exact: true }).fill(typed)
  await page.getByRole("button", { name: "Check your code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await markDrawn(page)
  await page.getByRole("button", { name: "Use this code" }).click()
  await expect(page.getByText(/^Code applied/)).toBeVisible()
  await expect(page.locator(`main[${OLD}]`)).toHaveCount(1)
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(typed)
  await expect(page.locator(".result")).toHaveCount(0)
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused()
})

test("a checkout drawn again for the tab's open order keeps focus on its heading", async ({ page }) => {
  await startOrder(page, uniqueLabel("headopen"), { method: "btc" })
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await search(page, uniqueLabel("headnext"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByText(/is waiting for its payment/)).toBeVisible()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeFocused()
})

test("an app link whose wallet fails its checksum does not work", async ({ page }) => {
  const label = uniqueLabel("cksum")
  await page.goto(`/#/?name=${label}&owner=${APP_WALLET}`)
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  await page.goto(`/#/?name=${label}&owner=${APP_WALLET.toLowerCase()}`)
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  await page.goto(`/#/?name=${label}&owner=${DAMAGED_WALLET}`)
  await expect(page.getByRole("heading", { name: "This link from SimpleX does not work" })).toBeVisible()
})

test("Enter in Add a code adds the code and closes the popup, with focus back on Add a code", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/#/names")
  await page.getByRole("button", { name: "Add a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page.locator(".row-item", { hasText: code })).toBeVisible()
  await expect(page.locator(".modal-overlay")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Add a code" })).toBeFocused()
})

test("a restore refused for the code itself puts focus back in the code's field", async ({ page }) => {
  await page.goto("/#/restore")
  await page.getByLabel("Name code").fill("SN-not-a-code")
  await page.getByRole("button", { name: "Restore" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("This code is not valid")).toBeVisible()
  await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled()
  await expect(page.getByLabel("Name code")).toBeFocused()
})

test("removing the code from a result searches again without it, with focus in the search box", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/")
  await page.getByRole("button", { name: "Check your code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.getByRole("button", { name: "Use this code" }).click()
  const label = uniqueLabel("rmcode")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Covered by your code")).toBeVisible()
  const entries = await page.evaluate(() => history.length)
  await page.locator(".covered").getByText("Remove").focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Register", exact: true })).toBeVisible()
  await expect(page.getByText("Covered by your code")).toHaveCount(0)
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused()
  expect(await page.getByLabel("Name", { exact: true }).evaluate((n: HTMLInputElement) => n.selectionStart === n.value.length)).toBe(true)
  expect(await page.evaluate(() => history.length)).toBe(entries)
})

test("a restore the service refuses puts focus back in the code's field, and the name code's lead keeps its period on its line", async ({ page }) => {
  await showOwnerCode(page, uniqueLabel("noorder"))
  await expect(page.locator(".inline-name").first()).toHaveText(/\.simplex\.$/)
  const ownerCode = (await page.getByTestId("owner-code").textContent())!.trim()
  await page.goto("/#/restore")
  await page.getByLabel("Name code").fill(ownerCode)
  await page.getByRole("button", { name: "Restore" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("No order was found for this code")).toBeVisible()
  await expect(page.getByLabel("Name code")).toBeFocused()
})

test("a pending code with no order leaves focus on the page when its Find link goes", async ({ page }) => {
  await showOwnerCode(page, uniqueLabel("nofind"))
  await page.goto("/#/names")
  const row = page.locator(".row-item").first()
  await row.getByText("Find the order").focus()
  await page.keyboard.press("Enter")
  await expect(row.getByText("No order was made")).toBeVisible()
  await focusOnPage(page)
})

test("Forget everything asks first with focus on Keep them, and keeping them gives focus back to the link", async ({ page }) => {
  await showOwnerCode(page, uniqueLabel("forget"))
  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Keep them" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Forget everything in this browser")).toBeFocused()
  await expect(page.locator(".row-item")).not.toHaveCount(0)
})

test("an app's order refused for its method draws the checkout again in place, with focus kept on Continue", async ({ page }) => {
  await page.goto(`/#/?name=${uniqueLabel("appunav")}&owner=${APP_WALLET}`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.locator(".method", { hasText: "Card" }).click()
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "provider_unavailable" } }) : route.continue())
  const entries = await page.evaluate(() => history.length)
  await page.getByRole("button", { name: "Continue" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Card is temporarily unavailable")).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue" })).toBeFocused()
  expect(await page.evaluate(() => history.length)).toBe(entries)
})

test("a code already in Your names is said so when added again, and a well-formed unknown code is not called a typo", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/#/names")
  for (const round of [1, 2]) {
    await page.getByRole("button", { name: "Add a code" }).click()
    await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
    if (round === 1) {
      await expect(page.locator(".verdict.ok")).toBeVisible()
      await page.getByRole("button", { name: "Add to your codes" }).click()
      await expect(page.locator(".row-item", { hasText: code })).toBeVisible()
    } else {
      await expect(page.locator(".verdict.bad")).toContainText("Already in your codes")
      await expect(page.getByRole("button", { name: "Add to your codes" })).toBeDisabled()
      await page.keyboard.press("Escape")
    }
  }
  await page.route("**/api/code/check", (route) => route.fulfill({ status: 400, json: { error: "code_invalid" } }))
  await page.getByRole("button", { name: "Add a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.bad")).toContainText("SimpleX did not issue it, or withdrew it.")
})
