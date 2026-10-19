import { type APIRequestContext, type Browser, expect, type Locator, type Page } from "@playwright/test"
import { control, savedCode, searchName, shot, startOrder, test, uniqueLabel, waitRegistered } from "./helpers.ts"

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
  await expect(page.locator(".page-head .lead")).toHaveText("Your code can no longer pay for it, so trying again cannot register it.")
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

// A prepaid code applied on search registers a new name with it; the page is left on the registration.
async function registerWithCode(page: Page, request: APIRequestContext, prefix: string): Promise<{ code: string; registrationId: string }> {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await page.getByRole("button", { name: "Use this code" }).click()
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel(prefix))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with code" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await savedCode(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.waitForURL(/\?registration=/)
  return { code, registrationId: new URL(page.url()).searchParams.get("registration")! }
}

test("a prepaid code is checked, applied on search, and registers a name with nothing to pay", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, years: 5 }) as { code: string }
  await page.goto("/")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code.toLowerCase())
  await expect(page.locator(".verdict.ok")).toContainText("Covers names of 6 or more letters, for 5 years.")
  await shot(page, "K1-code-valid")
  await page.getByRole("button", { name: "Use this code" }).click()
  await expect(page.getByText("Code applied: names of 6 or more letters, for 5\u00a0years. Search a name to use it.")).toBeVisible()
  await shot(page, "K1b-code-applied-home")

  const label = uniqueLabel("pre")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Code applied")).toBeVisible()
  await expect(page.locator(".result .chip", { hasText: "5 years + 30 days" })).toBeVisible()
  await shot(page, "K2-code-applied")
  await page.getByRole("button", { name: "Register with code" }).click()

  await expect(page.getByText("Paid with your code")).toBeVisible()
  await expect(page.locator(".crumb", { hasText: "Payment" })).toHaveCount(0)
  await shot(page, "K3-checkout-covered")
  await page.getByRole("button", { name: "Continue" }).click()
  await savedCode(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.waitForURL(/\?registration=/)
  await expect(page.locator(".crumb.on")).toHaveText("4Registration")
  await waitRegistered(page, label)
  await expect(page.getByText(/Registered for 5 years \+ 30 days/)).toBeVisible()
  await shot(page, "K8-registered-with-code")
  expect((await searchName(request, label)).status).toBe("registered")
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText("Registered")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toContainText(/paid with a code/i)
  await shot(page, "K10-names-paid-with-code")

  // the code is spent
  await page.goto("/")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.bad")).toContainText("This code was already used")
  await shot(page, "K5-code-used")
})

test("the checkout's code entry refuses a code for longer names, and the popup refuses typos and owner codes", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 8 }) as { code: string }
  await page.goto("/")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("SN7-BJTBP-29596-R3HJ8-25YM8")
  await expect(page.locator(".verdict.bad")).toContainText("This code is not valid")
  await shot(page, "K6-code-invalid")
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G")
  await expect(page.locator(".verdict.bad")).toContainText("This is a name code")
  await expect(page.getByText("Restore in Your names")).toBeVisible()
  await page.getByLabel("Close").click()

  const label = uniqueLabel("k7")
  await page.getByLabel("Name", { exact: true }).fill(label.slice(0, 7))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByText("I have a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.getByText(/This code covers names of 8 or more letters; .* has 7/)).toBeVisible()
  await shot(page, "K7-code-too-short")
})

test("a code added under Your names is listed, used, and forgotten", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 7 }) as { code: string }
  await page.goto("/#/names")
  await page.getByRole("button", { name: "Add a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await shot(page, "N12a-add-code")
  await page.getByRole("button", { name: "Add to your codes" }).click()
  const row = page.locator(".row-item", { hasText: code })
  await expect(row.locator(".chip")).toHaveText("Unused")
  await row.getByText("Use", { exact: true }).click()
  await expect(page).toHaveURL(/#\/$/)
  await page.getByLabel("Name", { exact: true }).fill("sixsix")
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Your code covers names of 7 or more letters.")).toBeVisible()

  await page.goto("/#/names")
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
  await page.getByRole("button", { name: "Continue" }).click()
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
  await page.getByRole("button", { name: "Continue" }).click()
  await savedCode(page)
  await page.route("**/api/invoice", (route) => route.fulfill({ status: 409, json: { error: "name_taken" } }))
  await page.getByRole("button", { name: "Continue to payment" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(label)
  await page.getByRole("link", { name: "Your names" }).first().click()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(page.getByText("No names in this browser yet.").or(page.locator(".row-item").first())).toBeVisible()
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toHaveCount(0)
})

test("a code order taken first gives its code back, ready for another name", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("ctk")
  await page.goto("/")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await page.getByRole("button", { name: "Use this code" }).click()
  await control(request, "take", { label })
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with code" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await savedCode(page)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: 120_000 })
  await expect(page.locator(".status .code-display")).toHaveText(code)
  await shot(page, "K9-code-released")
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: code }).locator(".chip")).toHaveText("Unused")
})

test("a retry refused for a code used elsewhere says the code is gone and offers no Try again, also once reopened", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "cgone")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator(".page-head .lead")).toHaveText("Your code is kept. Trying again spends nothing more.")
  await page.route("**/retry", (route) => route.fulfill({ status: 409, json: { error: "code_used" } }))
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByText("Your code was used for another name")).toBeVisible()
  await expect(page.locator(".page-head .lead")).toHaveText("Your code can no longer pay for it, so trying again cannot register it.")
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
  await expect(page.locator(".page-head .lead")).toHaveText("Your code can no longer pay for it, so trying again cannot register it.")
  await offersSearchInstead(page)
  expect(await saidKept(page), "the page opened first after the code went said it is kept").toBe(false)
  await reopenRefused(page)
})

test("a failed code order is drawn before its code is checked, and says the code is kept only once the check answers", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "ccheck")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  const lead = page.locator(".page-head .lead")
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
    await expect(page.locator(".page-head .lead"), state).toHaveText("Your code is kept. Trying again spends nothing more.")
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
    await expect(restored.locator(".page-head .lead")).toHaveText("Trying again spends nothing more.")
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
  await expect(page.locator(".page-head .lead")).toHaveText("About 3 minutes. Keep this page open: after the wait it signs the name to finish it.")
  await page.unrouteAll({ behavior: "ignoreErrors" })
})

test("a code used on an order page leads to search, and a search opened from the app refuses it", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const useIt = async () => {
    await page.getByRole("button", { name: "Check a code" }).click()
    await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
    await expect(page.locator(".verdict.ok")).toBeVisible()
    await page.getByRole("button", { name: "Use this code" }).click()
  }
  await startOrder(page, uniqueLabel("cpo"), { method: "btc" })
  await useIt()
  await page.waitForURL((url) => url.search === "" && url.hash === "#/")
  await expect(page.getByText("Code applied: names of 6 or more letters, for 2 years. Search a name to use it.")).toBeVisible()
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("cpn"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Code applied")).toBeVisible()

  await page.goto(`/#/?name=${uniqueLabel("cpa")}&owner=0x${"11".repeat(20)}`)
  await useIt()
  await expect(page.locator(".verdict.bad")).toContainText("An order opened from SimpleX is paid here, not with a code.")
})

test("a code applied from the header popup at checkout gives focus back to the redrawn header's Check a code", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto(`/#/?name=${uniqueLabel("cfo")}`)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Paid with your code")).toBeVisible()
  await expect(page.getByRole("button", { name: "Check a code" })).toBeFocused()
})

test("removing an applied code returns focus to the search box", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/#/names")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.getByRole("button", { name: "Use this code" }).click()
  await page.getByRole("button", { name: "Remove" }).click()
  await expect(page.getByText(/^Code applied/)).toHaveCount(0)
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused()
})

test("a device clock three minutes slow signs as soon as the service allows", async ({ page, request }) => {
  await page.clock.install({ time: Date.now() - 3 * 60_000 })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.getByRole("button", { name: "Use this code" }).click()
  const label = uniqueLabel("skew")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with code" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await savedCode(page)
  await page.getByRole("button", { name: "Register" }).click()
  await page.waitForURL(/\?registration=/)
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
  await page.goto("/")
  await page.getByRole("button", { name: "Check a code" }).click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
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
  await page.goto("/")
  await page.locator(".tile.invest").getByRole("button", { name: "Check your code" }).click()
  const popupField = page.getByRole("textbox", { name: "Code", exact: true })
  await popupField.fill(NAME_CODE)
  await expect(page.locator(".verdict.bad")).toContainText("This is a name code")
  const popup = await measure(popupField)
  await page.goto("/#/restore")
  const restoreField = page.getByLabel("Name code")
  await restoreField.fill(NAME_CODE)
  const restore = await measure(restoreField)
  await context.close()
  return { popup, restore }
}

for (const width of [1280, 390, FITS_FROM_PX]) {
  test(`a name code, the longest code, shows whole in the code popup and on restore at ${width} px`, async ({ browser, browserName }) => {
    const { popup, restore } = await codeFields(browser, browserName, width)
    expect(popup.overflow, "the code's width past the popup's field").toBeLessThanOrEqual(0)
    expect(restore.overflow, "the code's width past the restore field").toBeLessThanOrEqual(0)
    expect(Math.min(popup.font, restore.font), "the code's letter size").toBeGreaterThanOrEqual(LEGIBLE_PX)
  })
}

test(`below ${FITS_FROM_PX} px a name code keeps its letters at the legible floor, its field scrolling instead`, async ({ browser, browserName }) => {
  const { popup, restore } = await codeFields(browser, browserName, NARROWEST_PX)
  expect([popup.font, restore.font], "the code's letter size").toEqual([LEGIBLE_PX, LEGIBLE_PX])
})
