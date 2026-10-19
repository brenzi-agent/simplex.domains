import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { randomBytes } from "node:crypto"
import { durationFor, registerIntentDigest, type Registration } from "../src/crypto/registration.ts"
import { checksumAddress, fromHex, hex, signDigest, walletFromEntropy, type Wallet } from "../src/crypto/wallet.ts"
import { control, MOCK, REGISTRATION_MS, registrationOf, searchName, shot, startOrder, test, uniqueLabel } from "./helpers.ts"

const APP_SIGNS = "Waiting for SimpleX to sign the registration with your app's wallet."

async function orderFromApp(page: Page, app: Wallet, label: string, shots = false): Promise<string> {
  await page.goto(`/#/?name=${label}&owner=${checksumAddress(app.address)}`)
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  if (shots) await shot(page, "L1-from-app")
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByText("Point it at your SimpleX")).toHaveCount(0)
  await expect(page.getByText("I have a code")).toHaveCount(0)
  await expect(page.locator(".name-code")).toHaveCount(0)
  if (shots) await shot(page, "L2-checkout-from-app")
  await page.getByRole("button", { name: "Continue" }).click()
  await page.waitForURL(/\?order=/)
  return new URL(page.url()).searchParams.get("order")!
}

// The app's part: sign RegisterName with its own key, using the secret the page kept and the order's current nonce.
async function appSigns(page: Page, request: APIRequestContext, app: Wallet, label: string, invoiceId: string): Promise<number> {
  const record = await page.evaluate((l) => Object.keys(localStorage).filter((k) => k.startsWith("simplex-names:order:"))
    .map((k) => JSON.parse(localStorage.getItem(k)!)).find((o: { label: string }) => o.label === l), label)
  const view = (await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json()).registration
  const r: Registration = {
    label, tld: view.tld, owner: app.address, duration: durationFor(view.years), secret: fromHex(record.secret),
    resolver: fromHex(view.resolver), contactLinks: [], channelLinks: [],
  }
  const digest = registerIntentDigest(BigInt(view.chainId), fromHex(view.sponsor), r, BigInt(view.intentNonce), BigInt(view.revealBefore))
  const res = await request.post(`${MOCK}/api/registration/${view.id}/reveal`, {
    data: { label, secret: record.secret, records: { contact: [], channel: [] }, nonce: view.intentNonce, deadline: view.revealBefore, signature: hex(signDigest(app.privateKey, digest)) },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return view.intentNonce
}

test("an order opened from the app registers to the app's wallet once the app signs", async ({ page, request }) => {
  const app = walletFromEntropy(randomBytes(16))
  const label = uniqueLabel("app")
  const invoiceId = await orderFromApp(page, app, label, true)
  await page.goBack()
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  await page.goForward()
  // another browser knows the order only from the service, which seals nothing for an app's order
  const elsewhere = await page.context().browser()!.newContext()
  const stranger = await elsewhere.newPage()
  await stranger.goto(`/?order=${invoiceId}`)
  await expect(stranger.getByText("The name shows once it is registered")).toBeVisible()
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByText(APP_SIGNS)).toBeVisible({ timeout: 60_000 })
  await expect(stranger.getByText("Keep this page open while SimpleX finishes it.")).toBeVisible()
  await expect(stranger.getByText("Enter your name code")).toHaveCount(0)
  await elsewhere.close()
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toContainText("Waiting for SimpleX to sign it")
  await page.goto(`/?order=${invoiceId}`)
  await appSigns(page, request, app, label, invoiceId)
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
  await expect(page.getByRole("button", { name: "Back to SimpleX" })).toBeVisible()
  await shot(page, "L3-registered-to-app")
  expect((await searchName(request, label)).owner).toBe(checksumAddress(app.address))
})

test("an order opened from the app that meets a rate limit stays held and stays the app's", async ({ page }) => {
  const app = walletFromEntropy(randomBytes(16))
  const label = uniqueLabel("apphold")
  await page.goto(`/#/?name=${label}&owner=${checksumAddress(app.address)}`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "20" }, json: { error: "rate_limited" } }) : route.continue())
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.locator(".outcome .notice span[aria-hidden=true]")).toHaveText(/^Too many orders were tried from here\. Try again in \d+ seconds\.$/)
  // Back keeps the search opened from the app
  await page.getByRole("link", { name: "Back" }).click()
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled()
  await expect(page.getByText("Too many attempts")).toBeVisible()
})

test("two orders signed with one wallet's nonce both register: the second is signed again with the next nonce", async ({ browser, request }) => {
  const app = walletFromEntropy(randomBytes(16))
  const context = await browser.newContext()
  const [first, second] = [await context.newPage(), await context.newPage()]
  const labels = [uniqueLabel("appa"), uniqueLabel("appb")]
  const invoices = [await orderFromApp(first, app, labels[0]), await orderFromApp(second, app, labels[1])]
  await control(request, `settle/${invoices[0]}`)
  await control(request, `settle/${invoices[1]}`)
  await expect(first.getByText(APP_SIGNS)).toBeVisible({ timeout: 60_000 })
  await expect(second.getByText(APP_SIGNS)).toBeVisible({ timeout: 60_000 })
  const nonces = [await appSigns(first, request, app, labels[0], invoices[0]), await appSigns(second, request, app, labels[1], invoices[1])]
  expect(nonces[0]).toBe(nonces[1])
  await expect(first.getByRole("heading", { name: `${labels[0]}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
  // the second register reverts with the spent nonce, and the order waits for a new signature
  await expect.poll(async () => {
    const view = (await (await request.get(`${MOCK}/api/invoice/${invoices[1]}`)).json()).registration
    return view.phase === "committed" && view.label === null ? view.intentNonce : null
  }, { timeout: REGISTRATION_MS }).toBe(nonces[0] + 1)
  await expect(second.getByText(APP_SIGNS)).toBeVisible()
  expect(await appSigns(second, request, app, labels[1], invoices[1])).toBe(nonces[0] + 1)
  await expect(second.getByRole("heading", { name: `${labels[1]}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
  await context.close()
})

// Firefox reports a preload not used about ten seconds after its page loads
const PRELOAD_REPORT_MS = 12_000
const FONT_PRELOADS = 5

test("no page leaves a font preload unused in Firefox, whether a tab's first page or a later one", async ({ page, request, browser, baseURL, browserName }) => {
  test.skip(browserName !== "firefox", "only Firefox takes a tab's fonts from its own cache, past the preloads")
  const { invoiceId } = await startOrder(page, uniqueLabel("font"))
  const registrationId = await registrationOf(request, invoiceId)
  const fresh = await browser.newContext({ baseURL })
  try {
    const unused: string[] = []
    fresh.on("console", (m) => { if (m.type() === "warning" && m.text().includes("preloaded with link preload was not used")) unused.push(`${m.page()?.url()}: ${m.text()}`) })
    const tabs = await Promise.all(["/", `/?order=${invoiceId}`, `/#/edit/${registrationId}`].map(async (url) => {
      const tab = await fresh.newPage()
      await tab.goto(url)
      return tab
    }))
    expect(await tabs[0].locator("link[rel=preload][as=font]").count(), "the fonts preloaded on the tab's first page").toBe(FONT_PRELOADS)
    await tabs[0].reload()
    expect(await tabs[0].locator("link[rel=preload][as=font]").count(), "the fonts preloaded on the tab's later page").toBe(0)
    await tabs[0].waitForTimeout(PRELOAD_REPORT_MS)
    expect(unused).toEqual([])
  } finally {
    await fresh.close()
  }
})

// The first character of each line a text is drawn in.
const lineStarts = (text: Locator) => text.evaluate((root) => {
  const starts: string[] = []
  let top = -Infinity
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let i = 0; i < node.textContent!.length; i++) {
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const at = range.getBoundingClientRect().top
      if (at > top + 1) starts.push(node.textContent![i])
      top = Math.max(top, at)
    }
  }
  return starts
})

test("a name code too long for its line breaks after a hyphen, so no line starts with one", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto(`/#/?name=${uniqueLabel("wrap")}`)
  await page.getByRole("button", { name: "Register" }).click()
  const starts = await lineStarts(page.getByTestId("owner-code").locator(".code-text"))
  expect(starts.length, "the code wraps at this width").toBeGreaterThan(1)
  expect(starts.slice(1), "the first character of each later line").not.toContain("-")
})

test("the offline note leaves room under the foot, so the foot's last line scrolls clear of it", async ({ page, context }) => {
  await page.goto("/")
  await page.getByRole("heading", { name: "Your SimpleX domain" }).waitFor()
  await context.setOffline(true)
  try {
    await expect(page.locator(".offline-note")).toBeVisible()
    for (const size of [{ width: 1280, height: 900 }, { width: 360, height: 740 }]) {
      await page.setViewportSize(size)
      const covered = () => page.evaluate(() => {
        scrollTo(0, document.documentElement.scrollHeight)
        const note = document.querySelector(".offline-note")!.getBoundingClientRect().top
        return Math.max(...[...document.querySelectorAll(".foot .wrap > *")].map((n) => n.getBoundingClientRect().bottom)) - note
      })
      await expect.poll(covered, { message: `the foot's content under the note at ${size.width} px` }).toBeLessThanOrEqual(0)
    }
  } finally {
    await context.setOffline(false)
  }
})
