import { type APIRequestContext, type Browser, expect, type Locator, type Page } from "@playwright/test"
import { control, onStep, payButton, savedCode, search, searchName, shot, startOrder, test, uniqueLabel, waitRegistered } from "./helpers.ts"

// a commit's wait of about three minutes, counted from the service's own clock
const WAIT_S = 200

// Whether a page drawn after this ever said the code is kept, from its first frame on.
const watchKept = () => {
  const w = window as unknown as { __kept: boolean }
  w.__kept = false
  new MutationObserver(() => { if (document.body?.textContent?.includes("Your code is kept")) w.__kept = true }).observe(document, { childList: true, subtree: true, characterData: true })
}
const saidKept = (page: Page) => page.evaluate(() => (window as unknown as { __kept: boolean }).__kept)

const USED_WHY = "A code registers one name only."
// A code refused for good leaves nothing to try again: the page says why and offers another search instead.
async function offersSearchInstead(page: Page): Promise<void> {
  await expect(page.getByText(USED_WHY)).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Search a name" })).toBeVisible()
}

async function reopenRefused(page: Page): Promise<void> {
  await page.addInitScript(watchKept)
  await page.reload()
  await expect(page.locator(".screen > .lead")).toHaveText("Your code can no longer pay for it, so trying again cannot register it.")
  await expect(page.getByText("Your code was used for another name")).toBeVisible()
  await offersSearchInstead(page)
  expect(await saidKept(page), "the page said the code is kept before it said it is refused").toBe(false)
}

// another registration took the code once this one's failure let it go, and spent it
async function releasedAndUsed(request: APIRequestContext, code: string): Promise<void> {
  await control(request, "code/state", { code, state: "unused" })
  await control(request, "code/state", { code, state: "used" })
}

const keptRefusal = (page: Page, registrationId: string) =>
  page.evaluate((id) => JSON.parse(localStorage.getItem(`simplex-names:order:${id}`) ?? "{}").codeRefusal ?? null, registrationId)

const checkoutCode = (page: Page) => page.getByRole("textbox", { name: "I have a code" })
const total = (page: Page) => page.locator(".summary-card .total")

// The name searched is registered with a prepaid code entered at checkout; the page is left on the registration.
async function payWithCode(page: Page, label: string, code: string): Promise<void> {
  await search(page, label)
  await page.getByRole("button", { name: "Register", exact: true }).click()
  await checkoutCode(page).fill(code)
  await expect(page.getByText("Paid with your code")).toBeVisible()
  await savedCode(page)
  // the search's Register stays on its inert slide beside the checkout
  await onStep(page).getByRole("button", { name: "Register", exact: true }).click()
  await page.waitForURL(/\?registration=/)
}

async function registerWithCode(page: Page, request: APIRequestContext, prefix: string): Promise<{ code: string; registrationId: string }> {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await payWithCode(page, uniqueLabel(prefix), code)
  return { code, registrationId: new URL(page.url()).searchParams.get("registration")! }
}

// Your names' Add a code field
async function addCodeField(page: Page): Promise<Locator> {
  await page.goto("/#/names")
  return page.getByRole("textbox", { name: "Add a code" })
}

test("a prepaid code entered at checkout registers a name with nothing to pay", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, years: 5 }) as { code: string }
  const label = uniqueLabel("pre")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(total(page)).not.toContainText("$0.00")
  await checkoutCode(page).fill(code.toLowerCase())
  await expect(page.locator(".code-entry .verdict.ok")).toHaveText("Covers names of 6 or more letters, for 5 years.")
  await expect(total(page)).toContainText("$0.00")
  await expect(total(page).locator("s")).toBeVisible()
  await expect(page.locator(".summary-card")).toContainText("5 years + 30 days")
  await expect(page.getByText("Paid with your code")).toBeVisible()
  await expect(page.getByRole("radio")).toHaveCount(0)
  await shot(page, "K3-checkout-covered")
  const register = onStep(page).getByRole("button", { name: "Register", exact: true })
  await expect(register).toBeDisabled()
  await savedCode(page)
  await register.click()
  await page.waitForURL(/\?registration=/)
  await waitRegistered(page, label)
  await expect(page.getByText(/Registered for 5 years \+ 30 days/)).toBeVisible()
  await shot(page, "K8-registered-with-code")
  expect((await searchName(request, label)).status).toBe("registered")
  await page.goto("/#/names")
  const row = page.locator(".row-item", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip")).toHaveText("Registered")
  await expect(row).toContainText(/paid with a code/i)
  await shot(page, "K10-names-paid-with-code")

  // the code is spent
  await search(page, uniqueLabel("spent"))
  await page.getByRole("button", { name: "Register" }).click()
  await checkoutCode(page).fill(code)
  await expect(page.locator(".code-entry .verdict.bad")).toContainText("This code was already used")
  await expect(payButton(page)).toBeVisible()
  await expect(page.getByRole("radio")).toHaveCount(3)
  await shot(page, "K5-code-used")
})

test("a code entered at checkout stays with its name through Back and Register, and not with another name", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("stay")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  await checkoutCode(page).fill(code)
  await expect(total(page)).toContainText("$0.00")
  await page.goBack()
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(checkoutCode(page)).toHaveValue(code)
  await expect(page.locator(".code-entry .verdict.ok")).toBeVisible()
  await expect(total(page)).toContainText("$0.00")
  await expect(onStep(page).getByRole("button", { name: "Register", exact: true })).toBeVisible()
  // emptying the field takes the code off
  await checkoutCode(page).fill("")
  await expect(total(page)).not.toContainText("$0.00")
  await expect(payButton(page)).toBeVisible()
  await checkoutCode(page).fill(code)
  await expect(total(page)).toContainText("$0.00")

  await search(page, uniqueLabel("other"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(checkoutCode(page)).toHaveValue("")
  await expect(total(page)).not.toContainText("$0.00")
})

test("a code the service refuses as the order is sent leaves its field, says why there, and leaves the order to pay", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await search(page, uniqueLabel("used"))
  await page.getByRole("button", { name: "Register" }).click()
  await checkoutCode(page).fill(code)
  await expect(total(page)).toContainText("$0.00")
  await savedCode(page)
  await page.route("**/api/name/register", (route) => route.fulfill({ status: 409, json: { error: "code_used" } }))
  await onStep(page).getByRole("button", { name: "Register", exact: true }).click()
  const refusal = page.getByRole("status").filter({ hasText: "This code was already used." })
  await expect(refusal, "the refusal is said in the field's live line").toBeVisible()
  await expect(checkoutCode(page)).toHaveValue("")
  await expect(checkoutCode(page), "focus moves to the field, off Pay, which now pays money").toBeFocused()
  await expect(total(page)).not.toContainText("$0.00")
  await expect(page.getByRole("radio")).toHaveCount(3)
  await expect(payButton(page)).toHaveText(/^Pay \$[\d.,]+ with Bitcoin/)
  await expect(payButton(page)).toBeEnabled()
  // the refusal is the checkout's until the field is edited, also after a reload
  await page.reload()
  await expect(refusal).toBeVisible()
  await checkoutCode(page).fill("S")
  await expect(refusal).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(page.getByText("This code was already used.")).toHaveCount(0)
})

test("the checkout's code field refuses a code for longer names, typos and owner codes", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 8 }) as { code: string }
  await search(page, uniqueLabel("k7").slice(0, 7))
  await page.getByRole("button", { name: "Register" }).click()
  const verdict = page.locator(".code-entry .verdict.bad")
  await checkoutCode(page).fill("SN7-BJTBP-29596-R3HJ8-25YM8")
  await expect(verdict).toContainText("This code is not valid")
  await shot(page, "K6-code-invalid")
  await checkoutCode(page).fill("SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G")
  await expect(verdict).toContainText("This is a name code")
  await checkoutCode(page).fill(code)
  await expect(verdict).toHaveText(/^This code covers names of 8 or more letters; .* has 7\.$/)
  await expect(total(page)).not.toContainText("$0.00")
  await expect(page.getByRole("radio")).toHaveCount(3)
  await shot(page, "K7-code-too-short")
})

test("a code added under Your names is listed, and forgotten", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 7 }) as { code: string }
  await (await addCodeField(page)).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await shot(page, "N12a-add-code")
  await page.getByRole("button", { name: "Add", exact: true }).click()
  const row = page.locator(".row-item", { hasText: code })
  await expect(row.locator(".chip")).toHaveText("Unused")
  await page.getByText("Forget everything in this browser").click()
  await shot(page, "N12c-forget")
  await page.getByRole("button", { name: "Forget everything" }).click()
  await expect(page.getByText("No codes in this browser yet.")).toBeVisible()
})

test("an owner code shown at checkout is kept in Your names until its order exists", async ({ page }) => {
  const label = uniqueLabel("pend")
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByTestId("owner-code")).toBeVisible()
  await page.goto("/#/names")
  const row = page.locator(".row-item", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip")).toHaveText("Checkout not finished")
  await row.getByText("Find the order").click()
  await expect(row.locator(".chip")).toHaveText("No order was made")
  await shot(page, "N12d-unfinished-checkout")
  await row.getByText("Remove").click()
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toHaveCount(0)
})

test("an order refused at checkout for a name taken meanwhile leaves no unfinished checkout in Your names", async ({ page }) => {
  const label = uniqueLabel("ptk")
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register" }).click()
  await savedCode(page)
  await page.route("**/api/invoice", (route) => route.fulfill({ status: 409, json: { error: "name_taken" } }))
  await payButton(page).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(label)
  await page.getByRole("link", { name: "Your names" }).first().click()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(page.getByText("No names in this browser yet.").or(page.locator(".row-item").first())).toBeVisible()
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toHaveCount(0)
})

test("a code order taken first gives its code back, ready for another name", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("ctk")
  await control(request, "take", { label })
  await payWithCode(page, label, code)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: 120_000 })
  await expect(page.locator(".outcome .code-display")).toHaveText(code)
  await shot(page, "K9-code-released")
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: code }).locator(".chip")).toHaveText("Unused")
})

test("a retry refused for a code used elsewhere says the code is gone and offers no Try again, also once reopened", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "cgone")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator(".screen > .lead")).toHaveText("Your code is kept. Trying again spends nothing more.")
  await page.route("**/retry", (route) => route.fulfill({ status: 409, json: { error: "code_used" } }))
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByText("Your code was used for another name")).toBeVisible()
  await expect(page.locator(".screen > .lead")).toHaveText("Your code can no longer pay for it, so trying again cannot register it.")
  await offersSearchInstead(page)
  await page.getByRole("button", { name: "Search a name" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible()
  await reopenRefused(page)
})

test("a failed code order opened again after its code was used elsewhere offers no Try again, and from the first frame the time after", async ({ page, request }) => {
  const { code, registrationId } = await registerWithCode(page, request, "cgone")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  await releasedAndUsed(request, code)
  await page.addInitScript(watchKept)
  await page.reload()
  await expect(page.getByText("Your code was used for another name")).toBeVisible()
  await expect(page.locator(".screen > .lead")).toHaveText("Your code can no longer pay for it, so trying again cannot register it.")
  await offersSearchInstead(page)
  expect(await saidKept(page), "the page opened first after the code went said it is kept").toBe(false)
  await reopenRefused(page)
})

test("a failed code order is drawn before its code is checked, and says the code is kept only once the check answers", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "ccheck")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  const lead = page.locator(".screen > .lead")
  await page.addInitScript(watchKept)
  for (const unanswered of ["rate limit", "provider down", "dropped"]) {
    await page.route("**/api/code/check", (route) => unanswered === "dropped" ? route.abort()
      : route.fulfill(unanswered === "rate limit" ? { status: 429, headers: { "retry-after": "30" }, json: { error: "rate_limited" } } : { status: 503, json: { error: "provider_unavailable" } }))
    const asked = page.waitForRequest("**/api/code/check")
    await page.reload()
    await asked
    await expect(page.getByRole("heading", { name: "Not registered" }), unanswered).toBeVisible()
    await expect(lead, unanswered).toHaveText("Trying again spends nothing more.")
    await expect(page.getByRole("button", { name: "Try again" }), unanswered).toBeEnabled()
    expect(await saidKept(page), `${unanswered}: the page said the code is kept without an answer`).toBe(false)
    await page.unrouteAll({ behavior: "wait" })
  }
  let answer: () => void = () => undefined
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await page.route("**/api/code/check", async (route) => {
    await answered
    await route.continue()
  })
  await page.reload()
  await expect(page.getByRole("heading", { name: "Not registered" }), "the order is drawn while its code is checked").toBeVisible()
  await expect(lead).toHaveText("Trying again spends nothing more.")
  answer()
  await expect(lead, "the lead says the code is kept once the check answers").toHaveText("Your code is kept. Trying again spends nothing more.")
  await page.unrouteAll({ behavior: "wait" })
})

test("a failed code order whose code is revoked or past its date while still held by it offers Try again, which registers it", async ({ page, request }) => {
  const { code, registrationId } = await registerWithCode(page, request, "cheld")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  for (const state of ["expired", "revoked"]) {
    await control(request, "code/state", { code, state })
    await page.reload()
    await expect(page.locator(".screen > .lead"), state).toHaveText("Your code is kept. Trying again spends nothing more.")
    await expect(page.getByRole("button", { name: "Try again" }), state).toBeEnabled()
    expect(await keptRefusal(page, registrationId), state).toBeNull()
  }
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: /^Registering / })).toBeVisible()
})

test("an order restored in a browser without its code promises nothing of the code, and keeps the service's refusal of Try again", async ({ page, request, browser, baseURL }) => {
  const { code, registrationId } = await registerWithCode(page, request, "crest")
  const ownerCode = await page.evaluate((id) => JSON.parse(localStorage.getItem(`simplex-names:order:${id}`)!).ownerCode as string, registrationId)
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  await releasedAndUsed(request, code)
  const other = await browser.newContext({ baseURL, reducedMotion: "reduce" })
  try {
    const restored = await other.newPage()
    await restored.addInitScript(watchKept)
    await restored.goto("/#/restore")
    await restored.getByLabel("Name code", { exact: true }).fill(ownerCode)
    await restored.getByRole("button", { name: "Restore" }).click()
    await expect(restored.getByRole("heading", { name: "Not registered" })).toBeVisible()
    await expect(restored.locator(".screen > .lead")).toHaveText("Trying again spends nothing more.")
    expect(await saidKept(restored), "the restored order said its code is kept").toBe(false)
    await restored.getByRole("button", { name: "Try again" }).click()
    await expect(restored.getByText("Your code was used for another name")).toBeVisible()
    await offersSearchInstead(restored)
    expect(await keptRefusal(restored, registrationId)).toBe("code_used")
  } finally {
    await other.close()
  }
})

test("the registering page's lead tells the time left from the commit's wait", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "cwait")
  await page.route(`**/api/registration/${registrationId}*`, async (route) => {
    const response = await route.fetch()
    const view = await response.json()
    const serviceNow = Date.parse(response.headers()["date"]!) / 1000
    await route.fulfill({ response, json: { ...view, phase: "committed", label: null, commitTx: view.commitTx ?? `0x${"1".repeat(64)}`, revealAfter: serviceNow + WAIT_S } })
  })
  await page.reload()
  await expect(page.locator(".screen > .lead")).toHaveText("About 3 minutes. Keep this page open: after the wait it signs the name to finish it.")
  await page.unrouteAll({ behavior: "ignoreErrors" })
})

test("a device clock three minutes slow signs as soon as the service allows", async ({ page, request }) => {
  await page.clock.install({ time: Date.now() - 3 * 60_000 })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("skew")
  await payWithCode(page, label, code)
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: 60_000 })
})

test("restore on a fresh page works at once with the device clock 15 minutes off", async ({ page, browser }) => {
  const { ownerCode } = await startOrder(page, uniqueLabel("fresh"), { method: "btc" })
  const other = await browser.newContext()
  const fresh = await other.newPage()
  await fresh.clock.install({ time: Date.now() + 15 * 60_000 })
  await fresh.goto("/#/restore")
  await fresh.getByLabel("Name code").fill(ownerCode)
  await fresh.getByRole("button", { name: "Restore" }).click()
  await fresh.waitForURL(/\?order=/)
  await other.close()
})

test("a rate-limited code check says how long to wait", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.route("**/api/code/check", (route) => route.fulfill({ status: 429, headers: { "retry-after": "40" }, json: { error: "rate_limited" } }))
  await (await addCodeField(page)).fill(code)
  await expect(page.locator(".verdict.bad")).toContainText("Too many checks just now")
  await expect(page.locator(".verdict.bad")).toContainText("Try again in 40 seconds")
})

test("Your names reads a revoked code as not valid and offers no Use", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, state: "revoked" }) as { code: string }
  await page.goto("/")
  await page.evaluate((c) => localStorage.setItem(`simplex-names:code:${c}`, JSON.stringify({ code: c, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await page.goto("/#/names")
  const row = page.locator(".row-item", { hasText: code })
  await expect(row.locator(".chip")).toHaveText("Not valid")
  await expect(row.getByText("Use", { exact: true })).toHaveCount(0)
})

test("Your names keeps keyboard focus when another tab saves", async ({ page, request }) => {
  await startOrder(page, uniqueLabel("focus"), { method: "btc" })
  await page.goto("/#/names")
  const open = page.locator(".row-item").first().getByText("Open", { exact: true })
  await open.focus()
  const other = await page.context().newPage()
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await other.goto("/")
  await other.evaluate((c) => localStorage.setItem(`simplex-names:code:${c}`, JSON.stringify({ code: c, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await expect(page.locator(".row-item", { hasText: code })).toBeVisible()
  await expect(page.locator(".row-item").first().getByText("Open", { exact: true })).toBeFocused()
  await other.close()
})

test("a restore that fails on the network gives focus back to its button", async ({ page }) => {
  const { ownerCode } = await startOrder(page, uniqueLabel("rfocus"), { method: "btc" })
  await page.goto("/#/restore")
  await page.getByLabel("Name code").fill(ownerCode)
  await page.route("**/api/registration/find", (route) => route.abort())
  await page.getByRole("button", { name: "Restore" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("The service could not be asked now")).toBeVisible()
  await expect(page.getByRole("button", { name: "Restore" })).toBeFocused()
})

const NAME_CODE = "SN-GE65A-H60EF-815JQ-DT70X-DH67M-Q7M9J"
// the narrowest phone width at which a name code still fits its field whole, its letters at the legible floor or larger
const FITS_FROM_PX = 360
const NARROWEST_PX = 320
const LEGIBLE_PX = 11

// A phone's own scrollbars lie over the page; Chromium draws them so only when it is told it is a phone.
async function codeFields(browser: Browser, browserName: string, width: number) {
  const phone = width < 1000
  const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: phone && browserName === "chromium", hasTouch: phone })
  const page = await context.newPage()
  const measure = (field: Locator) => field.evaluate((n: HTMLInputElement) => ({ overflow: n.scrollWidth - n.clientWidth, font: parseFloat(getComputedStyle(n).fontSize) }))
  const listField = await addCodeField(page)
  await listField.fill(NAME_CODE)
  await expect(page.locator(".verdict.bad")).toContainText("This is a name code")
  const list = await measure(listField)
  await page.goto("/#/restore")
  const restoreField = page.getByLabel("Name code")
  await restoreField.fill(NAME_CODE)
  const restore = await measure(restoreField)
  await context.close()
  return { list, restore }
}

for (const width of [1280, 390, FITS_FROM_PX]) {
  test(`a name code, the longest code, shows whole in Your names' code field and on restore at ${width} px`, async ({ browser, browserName }) => {
    const { list, restore } = await codeFields(browser, browserName, width)
    expect(list.overflow, "the code's width past Your names' field").toBeLessThanOrEqual(0)
    expect(restore.overflow, "the code's width past the restore field").toBeLessThanOrEqual(0)
    expect(Math.min(list.font, restore.font), "the code's letter size").toBeGreaterThanOrEqual(LEGIBLE_PX)
  })
}

test(`below ${FITS_FROM_PX} px a name code keeps its letters at the legible floor or larger, a field too narrow scrolling instead`, async ({ browser, browserName }) => {
  const fields = await codeFields(browser, browserName, NARROWEST_PX)
  for (const [name, field] of Object.entries(fields)) {
    expect(field.font, `${name}: the code's letter size`).toBeGreaterThanOrEqual(LEGIBLE_PX)
    if (field.overflow > 0) expect(field.font, `${name}: the letter size of a code its field scrolls`).toBe(LEGIBLE_PX)
  }
})
