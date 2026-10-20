import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { randomBytes } from "node:crypto"
import { durationFor, registerIntentDigest, type Registration } from "../src/crypto/registration.ts"
import { checksumAddress, fromHex, hex, signDigest, walletFromEntropy, type Wallet } from "../src/crypto/wallet.ts"
import { control, MOCK, onStep, REGISTRATION_MS, registrationOf, search, searchName, shot, startOrder, test, toCodeStep, uniqueLabel } from "./helpers.ts"

const APP_SIGNS = "Waiting for SimpleX to sign the registration with your app's wallet."

async function orderFromApp(page: Page, app: Wallet, label: string, shots = false): Promise<string> {
  await page.goto(`/#/?name=${label}&owner=${checksumAddress(app.address)}`)
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  if (shots) await shot(page, "L1-from-app")
  await page.getByRole("button", { name: "Register" }).click()
  // the app holds the wallet, so its order skips the links and the name code
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#/checkout")
  await expect(page.getByText("I have a code")).toHaveCount(0)
  await expect(page.locator(".link-lines, .code-display")).toHaveCount(0)
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
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` })).toContainText("Waiting for SimpleX to sign it")
  await page.goto(`/?order=${invoiceId}`)
  await appSigns(page, request, app, label, invoiceId)
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
  await expect(page.getByRole("button", { name: "Back to SimpleX" })).toBeVisible()
  await expect(page.locator("body > main").getByRole("link", { name: "Your names" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Edit links" }), "the app sets the links of a name in its wallet").toHaveCount(0)
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
const FONT_PRELOADS = 4

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
  await search(page, uniqueLabel("wrap"))
  await toCodeStep(page)
  const starts = await lineStarts(onStep(page).getByTestId("owner-code"))
  expect(starts.length, "the code wraps at this width").toBeGreaterThan(1)
  expect(starts.slice(1), "the first character of each later line").not.toContain("-")
})

// a laptop's, a phone's and a small phone's window
const NOTE_SIZES = [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 740 }]
test("on a phone, Forget's two answers are an equal pair, both in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await search(page, uniqueLabel("pair"))
  await toCodeStep(page)
  // a code under the name makes the list reach past the window, as a browser that has bought some has
  await page.evaluate(() => localStorage.setItem("simplex-names:code:SN6-PAIR", JSON.stringify({ code: "SN6-Z6VPA-7YPF0-XN8B4-9S1ZD", minLength: 6, years: 2, addedAt: new Date().toISOString() })))
  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").click()
  const boxes = await Promise.all(["Forget everything", "Keep them"].map(async (name) => (await page.getByRole("button", { name }).boundingBox())!))
  expect(boxes[0].width, "the two answers' widths").toBeCloseTo(boxes[1].width, 0)
  const height = await page.evaluate(() => innerHeight)
  for (const box of boxes) expect(box.y >= 0 && box.y + box.height <= height, `an answer at ${box.y}-${box.y + box.height} in a window ${height} high`).toBe(true)
  await shot(page, "N12f-forget-ask")
})

test("offline, the footer scrolls clear of the note, and its last link takes a click there", async ({ page, context }) => {
  await page.goto("/")
  await page.getByRole("heading", { name: "Your SimpleX domain" }).waitFor()
  await context.setOffline(true)
  try {
    await expect(page.locator(".offline-note")).toBeVisible()
    const lastLink = page.locator("body > footer").getByRole("link", { name: "Trademark owners" })
    for (const size of NOTE_SIZES) {
      await page.setViewportSize(size)
      // how far each of the footer's items reaches past the note's top, scrolled to the end once the window has its new
      // size (Firefox takes it after Playwright's call returns), the note has its own and the frame and track have caught up
      const overlaps = () => page.evaluate(({ width, height: windowHeight }) => {
        const height = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height
        const frame = Math.ceil(height("body > header") + height("body > footer") + height("body > .offline"))
        // the home fills the window, so its parts add up to the window's height once its size has reached the page's layout
        const settled = innerWidth === width && innerHeight === windowHeight
          && Math.abs(frame + height("body > main") - windowHeight) < 1
          && getComputedStyle(document.documentElement).getPropertyValue("--frame-h") === `${frame}px`
          && Math.round(height(".track")) === Math.ceil(height(".slide:not([inert])"))
          // reduced motion still eases each style change over a frame, so the note grows to its height then
          && document.getAnimations().length === 0
        scrollTo(0, document.documentElement.scrollHeight)
        const noteTop = document.querySelector(".offline-note")!.getBoundingClientRect().top
        return { settled, overlaps: [...document.querySelectorAll("body > footer > *")].map((n) => Math.max(0, Math.ceil(n.getBoundingClientRect().bottom - noteTop))) }
      }, size)
      await expect.poll(overlaps, { message: `the footer's items under the note at ${size.width}x${size.height}` }).toEqual({ settled: true, overlaps: [0, 0] })
      // WebKit hit-tests a mouse event against the last frame it drew, so the scroll is drawn first
      await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
      const box = (await lastLink.boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await expect(page.getByRole("heading", { name: "Trademark owners" })).toBeVisible()
      await page.goBack()
      await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
    }
  } finally {
    await context.setOffline(false)
  }
})
