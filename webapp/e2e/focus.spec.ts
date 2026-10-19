import { expect, type Locator, type Page } from "@playwright/test"
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

test("removing a pending name code puts focus on the heading, so a second Enter removes nothing", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "Your names" })).toBeFocused()
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

test("an order's page keeps focus, and the phone menu stays open, when another tab changes the order", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("ordfocus"), { method: "btc" })
  const key = await page.evaluate((id) => Object.keys(localStorage).find((k) => k.startsWith("simplex-names:order:") && localStorage.getItem(k)!.includes(id))!, invoiceId)
  const other = await page.context().newPage()
  await other.goto("/")
  await page.getByRole("button", { name: "Cancel this invoice" }).focus()
  await markDrawn(page)
  await redrawnInPlace(page, invoiceId, () => touchRecord(other, key))
  await expect(page.getByText("Loading…")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Cancel this invoice" })).toBeFocused()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel("Menu").click()
  await expect(page.getByRole("link", { name: "Search" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Your names" })).toBeFocused()
  await redrawnInPlace(page, invoiceId, () => touchRecord(other, key))
  await expect(page.getByLabel("Menu")).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByRole("link", { name: "Your names" })).toBeFocused()
  await other.close()
})

test("a name typed but not searched stays when a code is applied from the popup", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await search(page, uniqueLabel("shown"))
  await expect(page.locator(".result")).toBeVisible()
  const typed = uniqueLabel("typed")
  await page.getByLabel("Name", { exact: true }).fill(typed)
  await page.getByRole("button", { name: "Check a code" }).click()
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

test("an app link whose wallet fails its checksum does not work, and a code used there goes to a search", async ({ page, request }) => {
  const label = uniqueLabel("cksum")
  await page.goto(`/#/?name=${label}&owner=${APP_WALLET}`)
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  await page.goto(`/#/?name=${label}&owner=${APP_WALLET.toLowerCase()}`)
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  await page.goto(`/#/?name=${label}&owner=${DAMAGED_WALLET}`)
  await expect(page.getByRole("heading", { name: "This link from SimpleX does not work" })).toBeVisible()

  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.getByRole("button", { name: "Use this code" }).click()
  await page.waitForURL((url) => url.hash === "#/")
  await expect(page.getByText(/^Code applied/)).toBeVisible()
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
  await page.getByRole("button", { name: "Check a code" }).click()
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

test("a pending code with no order puts focus on the heading when its Find link goes", async ({ page }) => {
  await showOwnerCode(page, uniqueLabel("nofind"))
  await page.goto("/#/names")
  const row = page.locator(".row-item").first()
  await row.getByText("Find the order").focus()
  await page.keyboard.press("Enter")
  await expect(row.getByText("No order was made")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeFocused()
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

test("a popup opened from the phone menu closes the menu first, and Escape gives focus back to the menu's toggle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByLabel("Menu").click()
  await page.getByRole("navigation").getByRole("button", { name: "Check a code" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByLabel("Menu")).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByLabel("Menu")).toBeFocused()
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
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.bad")).toContainText("SimpleX did not issue it, or withdrew it.")
})

async function hiddenUnderHeader(page: Page, stopAt: string, presses: number): Promise<string[]> {
  const hidden: string[] = []
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Shift+Tab")
    const seen = await page.evaluate((stop) => {
      const focused = document.activeElement as HTMLElement | null
      if (!focused?.closest("main")) return { stop: false, hidden: null }
      const header = document.querySelector("body > header.top")!.getBoundingClientRect()
      const top = focused.getBoundingClientRect().top
      return { stop: focused.matches(stop), hidden: top < header.bottom ? `${focused.tagName.toLowerCase()} "${(focused.textContent || focused.getAttribute("aria-label") || "").trim()}" at ${Math.round(top)}, header to ${Math.round(header.bottom)}` : null }
    }, stopAt)
    if (seen.hidden) hidden.push(seen.hidden)
    if (seen.stop) break
  }
  return hidden
}

for (const [device, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`keyboard focus going up the home page on a ${device} never lands under the sticky header`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/")
    await search(page, "bakery")
    await expect(page.getByRole("link", { name: "Open in SimpleX" }).first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), "a page long enough to scroll").toBe(true)
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur()
      window.scrollTo(0, document.documentElement.scrollHeight)
    })
    expect(await hiddenUnderHeader(page, 'input[aria-label="Name"]', 30)).toEqual([])
  })
}

// Chromium scrolls the page to where a control in the sticky header would be unstuck when that control takes focus.
// The home page scrolls further than this at both widths, whatever it lays out once resized.
const SCROLLED_PX = 300
test("closing a popup opened from the header, or the phone menu, leaves the page scrolled where it was", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("heading", { name: /Own your name/ }).waitFor()
  // a face loading later lays the page out taller above the place scrolled to, which WebKit then keeps in view
  await page.evaluate(() => document.fonts.ready)
  const scrolledDown = async () => {
    await page.evaluate((y) => scrollTo(0, y), SCROLLED_PX)
    await expect.poll(() => page.evaluate(() => scrollY), { message: "the page scrolled down" }).toBe(SCROLLED_PX)
  }
  // a pointer's press where the control is, as Playwright's own click first scrolls a sticky control to its unstuck place
  const press = async (control: Locator) => {
    const box = (await control.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }
  await scrolledDown()
  const header = page.locator("header.top")
  for (const close of ["Escape", "Close", "backdrop"]) {
    await press(header.getByRole("button", { name: "Check a code" }))
    await expect(page.getByRole("dialog")).toBeVisible()
    // a person closes it a frame or more after it is drawn; closed within that frame, WebKit moves the page once more
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    if (close === "Escape") await page.keyboard.press("Escape")
    else if (close === "Close") await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
    else await page.locator(".modal-overlay").click({ position: { x: 8, y: 8 } })
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(header.getByRole("button", { name: "Check a code" }), close).toBeFocused()
    expect(await page.evaluate(() => scrollY), `closed by ${close}`).toBe(SCROLLED_PX)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await scrolledDown()
  await press(page.getByRole("button", { name: "Menu" }))
  await expect(page.locator("header nav a").first()).toBeFocused()
  expect(await page.evaluate(() => scrollY), "the menu opened").toBe(SCROLLED_PX)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Menu" })).toBeFocused()
  expect(await page.evaluate(() => scrollY), "the menu closed").toBe(SCROLLED_PX)
})
