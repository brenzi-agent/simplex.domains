import { expect } from "@playwright/test"
import { labelHash } from "../src/crypto/registration.ts"
import { hex } from "../src/crypto/wallet.ts"
import { dateOf } from "../src/format.ts"
import { GRACE_S } from "../src/screens/names.ts"
import {
  control, LINKS_HEADING, onStep, payButton, recordedFrames, recordFrames, REGISTRATION_MS, search, searchName, shot, startOrder, test, toCodeStep, toReview, uniqueLabel,
  waitRegistered,
} from "./helpers.ts"

test.afterEach(async ({ request }) => {
  await control(request, "search", { chainDown: false, limitSeconds: 0, invoiceError: null, cancelStillOpen: false, findLimitSeconds: 0 })
})

test("search answers every kind of name", async ({ page, request }) => {
  await page.goto("/")
  await shot(page, "N1-home")
  await page.getByLabel("Name", { exact: true }).pressSequentially("BaKery")
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bakery")
  await shot(page, "N1a-typed")

  await search(page, "abc")
  await expect(page.getByText(/3 letters\. A name has 6 letters or more/)).toBeVisible()
  await shot(page, "N1b-short")
  await search(page, "bad_name")
  await expect(page.getByText(/^Use only a\W+z, 0\W+9 and single hyphens between them\.$/)).toBeVisible()
  await shot(page, "N1c-chars")

  await search(page, "bakery")
  await expect(page.locator(".answer .entity")).toHaveCount(2)
  await expect(page.locator(".answer .chip")).toHaveText("Taken")
  await expect(page.getByText("Alice's Bakery").or(page.getByText("Alice’s Bakery")).first()).toBeVisible()
  await shot(page, "N2a-taken")
  await search(page, "harbour")
  await expect(page.getByText("Registered, and not pointing at any address or channel that we know of yet.")).toBeVisible()
  await shot(page, "N2b-unlinked")
  await search(page, "support")
  await expect(page.locator(".answer .line")).toHaveText("Reserved names are not sold here. If it is yours to use, write to chat@simplex.chat.")
  await expect(page.locator(".answer").getByRole("link", { name: "chat@simplex.chat" })).toHaveAttribute("href", "mailto:chat@simplex.chat")
  await shot(page, "N2c-reserved")

  const label = uniqueLabel("free")
  await search(page, label)
  const card = page.locator(".answer .card")
  await expect(card).toContainText(`${label}.simplex`)
  await expect(card).toContainText("2 years + 30 days")
  await expect(card.locator(".price")).toHaveText(/^\$\d+$/)
  await expect(card.getByRole("button", { name: "Register" })).toBeEnabled()
  await shot(page, "N2-available")

  await control(request, "search", { chainDown: true })
  await search(page, uniqueLabel("down"))
  await expect(page.locator(".answer .line")).toHaveText("This name could not be checked. Try again")
  await shot(page, "N2d-unchecked")
  await control(request, "search", { chainDown: false, limitSeconds: 30 })
  await search(page, uniqueLabel("lim"))
  await expect(page.locator(".answer [aria-hidden=true]", { hasText: /^Searching is paused: try again in \d+ seconds\.$/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Search" })).toBeDisabled()
  await shot(page, "N2e-rate-limited")
})

test("the home fills the window between its header and footer without scrolling, as the landing does", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto("/")
    await page.evaluate(() => document.fonts.ready)
    const fit = () => page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight,
      gap: Math.round(document.querySelector("body > footer")!.getBoundingClientRect().top - document.querySelector(".home")!.getBoundingClientRect().bottom),
    }))
    await expect.poll(fit, `${viewport.width} px: the page's height, and the room between the home and the footer`).toEqual({ scroll: viewport.height, gap: 0 })
  }
})

test("the home's field, Search and Register are one height, on a laptop and on a phone", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await search(page, uniqueLabel("height"))
    await expect(page.getByRole("button", { name: "Register" })).toBeVisible()
    const heights = await Promise.all([page.locator(".search-row .field"), page.getByRole("button", { name: "Search" }), page.getByRole("button", { name: "Register" })]
      .map((control) => control.evaluate((node) => Math.round(node.getBoundingClientRect().height))))
    expect(new Set(heights).size, `${viewport.width} px: the field's, Search's and Register's heights ${heights}`).toBe(1)
  }
})

test("the checkout explains every refusal and keeps the order", async ({ page, request }) => {
  const label = uniqueLabel("ref")
  await search(page, label)
  await toReview(page)
  const pay = () => payButton(page).click()

  await control(request, "search", { invoiceError: "provider_unavailable" })
  await pay()
  await expect(page.getByText("Bitcoin is temporarily unavailable")).toBeVisible()
  await shot(page, "N3a-method-unavailable")
  await page.getByRole("radio", { name: "Monero" }).click()

  await control(request, "search", { invoiceError: "rate_limited" })
  await pay()
  await expect(page.getByRole("heading", { name: "Too many attempts" })).toBeVisible()
  await shot(page, "N3c-rate-limited")
  // Try again turns on once the wait is over and draws the checkout again
  await page.getByRole("button", { name: "Try again" }).click()

  await control(request, "search", { invoiceError: "internal" })
  await pay()
  await expect(page.getByRole("heading", { name: "That did not go through" })).toBeVisible()
  await shot(page, "N3d-failed")
  // Try again sends the same order again, which meets the next refusal
  await control(request, "search", { invoiceError: "catalog_changed" })
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "The price changed" })).toBeVisible()
  await shot(page, "N3b-price-changed")
})

test("a name registered by someone else while its order is checked says so at Pay, and that nothing was charged", async ({ page, request }) => {
  const label = uniqueLabel("gone")
  await search(page, label)
  await toReview(page)
  await control(request, "take", { label })
  await expect.poll(async () => (await searchName(request, label)).status, { timeout: REGISTRATION_MS }).toBe("registered")
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: "This name is no longer available" })).toBeVisible()
  await expect(onStep(page).getByText(`${label}.simplex became unavailable after you searched for it. Nothing was charged.`)).toBeVisible()
  await shot(page, "N3g-taken-at-pay")
  await onStep(page).getByRole("button", { name: "Search another name" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("")
})

test("without storage the name code step says the code shown is the only copy, and the order still registers", async ({ browser, request }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError") } })
  })
  const page = await context.newPage()
  const label = uniqueLabel("nos")
  await search(page, label)
  await toCodeStep(page)
  await expect(onStep(page).getByText("This code could not be saved in this browser")).toBeVisible()
  await expect(onStep(page).getByText("Save a copy now: it will be the only one.")).toBeVisible()
  await shot(page, "N3f-no-storage")
  await page.goto("/")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await context.close()
})

test("the footer's Trademark owners link opens the trademark page", async ({ page }) => {
  await page.goto("/")
  await page.locator("body > footer").getByRole("link", { name: "Trademark owners" }).click()
  await expect(page.getByRole("heading", { name: "Trademark owners" })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#/trademarks")
})

test("without storage two expired invoices of one order do not lead to each other", async ({ browser, request }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError") } })
  })
  const page = await context.newPage()
  const { invoiceId } = await startOrder(page, uniqueLabel("loop"), { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `expire/${second}`)
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  // a redirect loop would move the page off this invoice within a poll or two
  await page.waitForTimeout(3000)
  expect(new URL(page.url()).searchParams.get("order")).toBe(second)
  await expect(page.getByRole("button", { name: "Get a new invoice" })).toBeEnabled()
  await context.close()
})

test("a new invoice for a method that is unavailable says so and offers another way", async ({ page, request }) => {
  const label = uniqueLabel("unav")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await control(request, "search", { invoiceError: "provider_unavailable" })
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await expect(page.getByText("Bitcoin is unavailable right now")).toBeVisible()
  await page.getByRole("link", { name: "order the name again" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(label)
})

test("a double click acts once, whatever the redrawn page puts under the pointer", async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 900 })
  await search(page, uniqueLabel("dbl"))
  await page.getByRole("button", { name: "Register" }).dblclick()
  await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  // the second click did not go on to the name code step, nor into a link field
  expect(new URL(page.url()).hash).toBe("#/checkout/links")
  await expect(onStep(page).getByRole("textbox", { name: "Address" })).not.toBeFocused()
  await expect(onStep(page).getByRole("button", { name: "Skip for now" })).toBeEnabled()
})

test("restore waits out a rate limit on finding a code's orders", async ({ page, request }) => {
  const { ownerCode } = await startOrder(page, uniqueLabel("rlim"), { method: "btc" })
  await control(request, "search", { findLimitSeconds: 3 })
  await page.goto("/#/restore")
  await page.getByLabel("Name code").fill(ownerCode)
  await page.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled()
  // a screen reader hears the wait once, from a still copy; the countdown itself is hidden from it
  await expect(page.locator(".sr-only", { hasText: "Your code is fine. Try again in 3 seconds." })).toHaveCount(1)
  await expect(page.locator(".notice span[aria-hidden=true]")).toBeVisible()
  // typing meanwhile does not shorten the wait
  await page.getByLabel("Name code").press("End")
  await page.getByLabel("Name code").press("Space")
  await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Restore" })).toBeEnabled({ timeout: 10_000 })
  await page.getByRole("button", { name: "Restore" }).click()
  await page.waitForURL(/\?order=/)
})

test("a link from the app with a damaged wallet says it does not work", async ({ page }) => {
  await page.goto("/#/?name=bakery&owner=0x123")
  await expect(page.getByRole("heading", { name: "This link from SimpleX does not work" })).toBeVisible()
  await page.getByRole("link", { name: "Search here" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bakery")
  await expect(page.getByText("Opened from SimpleX.")).toHaveCount(0)
})

test("a search link's name is shown folded to lower case", async ({ page }) => {
  await page.goto("/#/?name=Harbour.SIMPLEX")
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("harbour")
})

test("a rate limit answered by a proxy pauses search like the service's own", async ({ page }) => {
  await page.route("**/api/name/**", (route) => route.fulfill({ status: 429, headers: { "retry-after": "20" }, contentType: "text/html", body: "<html>Too Many Requests</html>" }))
  await search(page, uniqueLabel("proxy"))
  await expect(page.locator(".answer [aria-hidden=true]", { hasText: /try again in \d+ seconds/ })).toBeVisible()
})

test("Back to a search from the links step shows its answer at once", async ({ page }) => {
  await search(page, uniqueLabel("back"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] }
    w.__seen = []
    new MutationObserver((records) => {
      for (const n of records.flatMap((r) => [...r.addedNodes])) {
        if (n instanceof Element && n.matches(".home") && !n.querySelector(".answer .card")) w.__seen.push("a home without the answer")
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  const rechecked = page.waitForResponse(/\/api\/name\/(0x)?[0-9a-f]{64}/)
  await page.goBack()
  await expect(page.getByRole("button", { name: "Register" })).toBeVisible()
  await rechecked
  await expect(page.getByRole("button", { name: "Register" })).toBeEnabled()
  expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([])
})

for (const [failure, change, shown] of [
  ["the service is down", { chainDown: true }, "This name could not be checked"],
  ["searching is rate limited", { limitSeconds: 10 }, "Searching is paused"],
] as const) {
  test(`Back to a search whose check fails because ${failure} no longer offers the remembered answer`, async ({ page, request }) => {
    await search(page, uniqueLabel("backfail"))
    await page.getByRole("button", { name: "Register" }).click()
    await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
    await control(request, "search", change)
    const rechecked = page.waitForResponse(/\/api\/name\/(0x)?[0-9a-f]{64}/)
    await page.goBack()
    await rechecked
    await expect(page.locator(".answer .line", { hasText: shown })).toBeVisible()
    await expect(page.getByRole("button", { name: "Register" })).toHaveCount(0)
    await expect(page.locator(".answer .card")).toHaveCount(0)
  })
}

test("a search pause reads the same after leaving the page and coming back", async ({ page, request }) => {
  await page.goto("/")
  await control(request, "search", { limitSeconds: 30 })
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("pauseback"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  const notice = page.locator(".answer .line")
  await expect(notice).toContainText("Searching is paused: try again in")
  const before = (await notice.innerText()).replace(/try again in \d+ seconds?/g, "")
  await page.getByRole("link", { name: "Your names" }).first().click()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await page.goBack()
  await expect(notice).toBeVisible()
  expect((await notice.innerText()).replace(/try again in \d+ seconds?/g, "")).toBe(before)
})

// an expiry ten days ago, well inside the chain's grace period
const LAPSED_S = 10 * 86_400
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"

test("search shows an expired name of yours with when it ran out and when it can be registered again", async ({ page }) => {
  const label = uniqueLabel("lapse")
  const hash = hex(labelHash(label))
  const expiresAt = Math.floor(Date.now() / 1000) - LAPSED_S
  await page.goto("/#/trademarks")
  await page.evaluate(({ label, hash, owner }) => localStorage.setItem("simplex-names:order:reg-lapsed", JSON.stringify({
    registrationId: "reg-lapsed", invoiceId: null, label, ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner, contact: "", channel: "", method: "code", paid: 0,
    years: 2, secret: "0x01", tld: "simplex", createdAt: new Date().toISOString(),
    request: { labelHash: hash, length: label.length, owner, commitment: "0x01", sealed: "sealed" },
  })), { label, hash, owner: OWNER })
  await page.route("**/api/name/**", (route) => route.fulfill({ json: {
    status: "registered", entities: [], owner: OWNER, records: { contact: "", channel: "" }, recordsNonce: 0, expiresAt, tld: "simplex",
  } }))
  await page.goto(`/#/?name=${label}`)
  await expect(page.locator(".answer .chip", { hasText: "Expired" })).toBeVisible()
  await expect(page.locator(".answer .note")).toHaveText(`Its registration ran out on ${dateOf(expiresAt)}. It can be registered again from ${dateOf(expiresAt + GRACE_S)}.`)
})

const SEARCH_RTT_MS = 300

test("as a search pause ends, the paused line gives way to a checking line rather than the invest block, until the answer", async ({ page, request }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Invest to claim your name" })).toBeVisible()
  // what each drawn frame shows below the search, from the press on
  await recordFrames(page, () => {
    const invest = document.querySelector<HTMLElement>(".below .cta")
    const shown = document.querySelector(".answer .card") ? "answer" : document.querySelector(".answer .line")?.textContent ?? ""
    return invest && invest.getClientRects().length > 0 ? `invest${shown ? ` + ${shown}` : ""}` : shown
  })
  // each search takes a moment to answer, as one over a network does
  await page.route(/\/api\/name\//, async (route) => {
    await new Promise((answered) => setTimeout(answered, SEARCH_RTT_MS))
    await route.continue()
  })
  await control(request, "search", { limitSeconds: 1 })
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("resume"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .line", { hasText: "Searching is paused" })).toBeVisible()
  await expect(page.locator(".answer .card")).toBeVisible({ timeout: 30_000 })
  const frames = await recordedFrames<string>(page)
  const paused = frames.findIndex((f) => f.startsWith("Searching is paused"))
  const answered = frames.indexOf("answer")
  expect(paused, "a frame with the paused line").toBeGreaterThanOrEqual(0)
  const between = [...new Set(frames.slice(paused, answered))]
  expect(between.filter((f) => !f.startsWith("Searching is paused") && f !== "Checking the name…"), "what showed between the pause and the answer").toEqual([])
})
