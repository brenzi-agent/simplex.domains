import { expect, type Page } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { checksumAddress } from "../src/crypto/wallet.ts"
import {
  addNameCode, control, MOCK, onStep, payButton, search, searchName, sevenLetters, shot, takenOrder, test, toReview, uniqueLabel, waitRegistered,
} from "./helpers.ts"

const balanceRow = (page: Page) => onStep(page).locator(".list-row[data-key^='balance-']")
const chip = (page: Page) => page.locator(".code-chip")

// Your names, its rows read
async function yourNames(page: Page): Promise<void> {
  await page.goto("/#/names")
  await expect(onStep(page).getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(onStep(page).locator(".chip", { hasText: "Checking" })).toHaveCount(0)
}

// a page moved on to another invoice than `from`, rather than to a page of none
const otherInvoice = (from: string) => (url: URL) => url.searchParams.get("order") !== null && url.searchParams.get("order") !== from

interface MockInvoice { amount: number; status: string; registration: { id: string; price: number; fromBalance: number; phase: string; balance: unknown } }
const invoiceOf = async (page: Page, invoiceId: string) => (await (await page.request.get(`${MOCK}/api/invoice/${invoiceId}`)).json()) as MockInvoice

test("a paid order taken first keeps its price as its balance, which a cheaper name spends keeping the rest, and a dearer one with the difference by card", async ({ page, request }) => {
  const label = sevenLetters()
  const { invoiceId, ownerCode } = await takenOrder(page, request, label)
  await yourNames(page)
  await expect(balanceRow(page)).toHaveCount(1)
  await expect(balanceRow(page).locator(".main")).toHaveText(`$200From ${label}.simplex, registered by someone else first`)
  // the order taken first is no name of this browser's: its balance alone stands for it
  await expect(onStep(page).locator(".list-row", { hasText: `${label}.simplex` })).toHaveCount(1)
  await shot(page, "B1-names-balance")

  // support refunds by hand, on a message quoting the reference
  await balanceRow(page).getByRole("button", { name: "Refund" }).click()
  const popup = page.getByRole("dialog", { name: "Refund" })
  await expect(popup).toContainText("Write to chat@simplex.chat with your order reference. Support refunds what is left of your balance.")
  await expect(popup.locator(".code-text")).toHaveText(invoiceId)
  await expect(popup.getByRole("button", { name: "Copy reference" })).toBeFocused()
  await shot(page, "B2-refund")
  await popup.getByRole("button", { name: "Close" }).click()
  await expect(balanceRow(page).getByRole("button", { name: "Refund" })).toBeFocused()

  await balanceRow(page).getByRole("button", { name: "Use" }).click()
  await expect(chip(page)).toContainText("Balance: $200")
  const cheaper = uniqueLabel("bcheap")
  await search(page, cheaper)
  await expect(page.locator(".answer .hint")).toHaveText("Paid from your balance. $100 stays in it.")
  await shot(page, "B3-home-balance")
  await toReview(page)
  await expect(onStep(page).locator(".order > .row .price")).toHaveText("$100")
  await expect(onStep(page).locator(".trow", { hasText: "From your balance" })).toContainText("−$100")
  await expect(onStep(page).locator(".trow.total")).toHaveText(/^To pay\s*\$0$/)
  await shot(page, "B4-review-balance")
  await onStep(page).getByRole("button", { name: "Register with your balance" }).click()
  await page.waitForURL(/\?registration=/)
  await waitRegistered(page, cheaper)
  expect((await searchName(request, cheaper)).owner).toBe(checksumAddress(walletOf(ownerCode)!.address))

  await yourNames(page)
  await expect(balanceRow(page).locator(".price")).toHaveText("$100")
  await expect(onStep(page).locator(".list-row", { hasText: `${cheaper}.simplex` }).locator(".sub")).toContainText("Until")
  await balanceRow(page).getByRole("button", { name: "Use" }).click()
  const dearer = sevenLetters()
  await search(page, dearer)
  await expect(page.locator(".answer .hint")).toHaveText("Your balance covers $100. You pay $100.")
  await shot(page, "B5-home-balance-more")
  await toReview(page)
  await expect(onStep(page).locator(".trow.total")).toHaveText(/^To pay\s*\$100$/)
  await page.getByRole("radio", { name: "Card" }).click()
  await expect(payButton(page)).toHaveText("Pay $100 with Card")
  await shot(page, "B6-review-balance-more")
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const difference = new URL(page.url()).searchParams.get("order")!
  await expect(onStep(page).getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await expect(onStep(page).locator(".screen-head .lead")).toHaveText(`${dearer}.simplex · $200 / 2 years · $100 from your balance`)
  await expect(onStep(page).getByRole("button", { name: "Pay $100" })).toBeVisible()
  await shot(page, "B7-pay-difference")
  await onStep(page).getByRole("button", { name: "Pay $100" }).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  await control(request, `settle/${difference}`)
  await waitRegistered(page, dearer)
  expect((await invoiceOf(page, difference)).registration).toMatchObject({ price: 20000, fromBalance: 10000 })

  // the balance is spent, so the order taken first is listed as a name taken first
  await yourNames(page)
  await expect(balanceRow(page)).toHaveCount(0)
  await expect(onStep(page).locator(".list-row", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText("Taken first")
})

test("a difference invoice cancelled frees its balance, which Order the name again spends again, as a new invoice does after it expires", async ({ page, request }) => {
  const label = uniqueLabel("bhold")
  await takenOrder(page, request, label)
  await page.getByRole("button", { name: "Choose another name" }).click()
  const dearer = sevenLetters()
  await search(page, dearer)
  await toReview(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const first = new URL(page.url()).searchParams.get("order")!
  await expect(onStep(page).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(onStep(page).locator(".screen-head .lead")).toContainText("$100 from your balance")

  // held by the open invoice, the balance offers neither Use nor Refund, and leads to the order holding it
  await yourNames(page)
  await expect(balanceRow(page).locator(".chip")).toHaveText("In use")
  await expect(balanceRow(page).locator(".sub")).toContainText("in use by another order until")
  await expect(balanceRow(page).getByRole("button", { name: "Use" })).toHaveCount(0)
  await shot(page, "B8-names-balance-held")
  await balanceRow(page).getByRole("button", { name: "Open that order" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") === first)

  await onStep(page).getByRole("button", { name: "Cancel this invoice" }).click()
  await expect(onStep(page).getByRole("button", { name: "Order the name again" })).toBeVisible()
  await yourNames(page)
  await expect(balanceRow(page).getByRole("button", { name: "Use" }), "the cancel released the hold").toBeVisible()
  await page.goto(`/?order=${first}`)
  await onStep(page).getByRole("button", { name: "Order the name again" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(chip(page)).toContainText("Balance: $100")
  await expect(onStep(page).locator(".trow.total")).toHaveText(/^To pay\s*\$100$/)
  await onStep(page).locator(".check.terms .box").click()
  await payButton(page).click()
  await page.waitForURL(otherInvoice(first))
  const second = new URL(page.url()).searchParams.get("order")!
  expect((await invoiceOf(page, second)).registration).toMatchObject({ price: 20000, fromBalance: 10000 })

  // an expired difference invoice's new invoice is a new spend of the balance, for the rest only
  await control(request, `expire/${second}`)
  await onStep(page).getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL(otherInvoice(second))
  const third = await invoiceOf(page, new URL(page.url()).searchParams.get("order")!)
  expect([third.amount, third.registration.price, third.registration.fromBalance]).toEqual([10000, 20000, 10000])
})

test("the name code shows the balance in another browser, a spend meeting a refund says so, and a refund support records shows as refunded", async ({ page, browser, request }) => {
  const label = uniqueLabel("bref")
  const { invoiceId, ownerCode } = await takenOrder(page, request, label)
  const kept = `$100From ${label}.simplex, registered by someone else first`
  const other = await browser.newContext()
  const restored = await other.newPage()
  await addNameCode(restored, ownerCode)
  await expect(onStep(restored).locator(".list-row[data-key^='balance-'] .main")).toHaveText(kept)
  await expect(onStep(restored).locator(".list-row[data-key^='balance-']").getByRole("button", { name: "Use" })).toBeVisible()
  await other.close()

  // support refunds the balance while a spend of it is being decided, which the spend then meets
  await yourNames(page)
  await balanceRow(page).getByRole("button", { name: "Use" }).click()
  await search(page, uniqueLabel("brefn"))
  await toReview(page)
  await control(request, `refund/${invoiceId}`)
  await onStep(page).getByRole("button", { name: "Register with your balance" }).click()
  await expect(onStep(page).getByText("Your balance was spent or refunded meanwhile, so this order is paid in full.")).toBeVisible()
  await expect(chip(page)).toBeHidden()
  await expect(onStep(page).locator(".trow.total")).toHaveText(/^Total\s*\$100$/)
  await expect(payButton(page)).toHaveText("Pay $100 with Bitcoin")
  await shot(page, "B9-review-balance-gone")

  await yourNames(page)
  await expect(balanceRow(page).locator(".main")).toHaveText(`$0From ${label}.simplex, registered by someone else first · refunded $100 by support`)
  await expect(balanceRow(page).getByRole("button")).toHaveCount(0)
})

test("a review whose balance another order's open invoice holds turns its button off, names that order, and turns it on once the invoice closes", async ({ page, request }) => {
  await takenOrder(page, request, uniqueLabel("bheld"))
  await page.getByRole("button", { name: "Choose another name" }).click()
  await search(page, uniqueLabel("bheldc"))
  await toReview(page)
  const register = onStep(page).getByRole("button", { name: "Register with your balance" })
  await expect(register).toBeEnabled()

  // another tab of this browser spends the balance on a dearer name, whose invoice for the difference holds it
  const other = await page.context().newPage()
  await yourNames(other)
  await balanceRow(other).getByRole("button", { name: "Use" }).click()
  const dearer = sevenLetters()
  await search(other, dearer)
  await toReview(other)
  await payButton(other).click()
  await other.waitForURL(/\?order=/)
  await expect(onStep(other).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()

  await register.click()
  const held = onStep(page).locator(".line", { hasText: "Your balance is in use by" })
  await expect(held).toHaveText(new RegExp(`^Your balance is in use by ${dearer}\\.simplex until \\d\\d:\\d\\d\\.$`))
  await expect(register).toBeDisabled()
  await shot(page, "B10-review-balance-held")
  await held.getByRole("link").click()
  await page.waitForURL((url) => url.searchParams.get("order") === new URL(other.url()).searchParams.get("order"))
  await page.goBack()
  await expect(held).toBeVisible()

  await onStep(other).getByRole("button", { name: "Cancel this invoice" }).click()
  await expect(held).toHaveCount(0)
  await expect(register).toBeEnabled()
  await other.close()
})

test("a balance held by another browser's invoice whose payment is confirming past its expiry names that order, says so without a time, and is read at a pause", async ({ page, browser, request }) => {
  const { ownerCode } = await takenOrder(page, request, uniqueLabel("bconf"))
  // this browser's own invoice for the difference, expired since: an order of the balance that holds nothing
  await page.getByRole("button", { name: "Choose another name" }).click()
  await search(page, sevenLetters())
  await toReview(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await control(request, `expire/${new URL(page.url()).searchParams.get("order")}`)
  await yourNames(page)
  await balanceRow(page).getByRole("button", { name: "Use" }).click()
  await search(page, uniqueLabel("bconfc"))
  await toReview(page)

  // another browser holding the code spends the balance on a dearer name; money reaches its invoice and confirms past its expiry
  const other = await browser.newContext()
  const away = await other.newPage()
  await addNameCode(away, ownerCode)
  await balanceRow(away).getByRole("button", { name: "Use" }).click()
  const dearer = sevenLetters()
  await search(away, dearer)
  await toReview(away)
  await payButton(away).click()
  await away.waitForURL(/\?order=/)
  const holder = new URL(away.url()).searchParams.get("order")!
  await control(request, `partial/${holder}`)
  await control(request, `overdue/${holder}`)
  await other.close()

  const reads: number[] = []
  page.on("request", (r) => { if (r.method() === "GET" && /\/api\/registration\/[^/?]+$/.test(new URL(r.url()).pathname)) reads.push(Date.now()) })
  await onStep(page).getByRole("button", { name: "Register with your balance" }).click()
  const held = onStep(page).locator(".line", { hasText: "Your balance is in use by" })
  await expect(held).toHaveText(`Your balance is in use by ${dearer}.simplex while its payment is being confirmed.`)
  await expect(onStep(page).getByRole("button", { name: "Register with your balance" })).toBeDisabled()
  await page.waitForTimeout(8_000)
  expect(reads.length, `reads of the balance in ${reads.length ? reads[reads.length - 1] - reads[0] : 0} ms`).toBeLessThanOrEqual(3)

  // the holder's payment settles, which spends the balance; the review says so
  await control(request, `settle/${holder}`)
  await expect(onStep(page).getByText("Your balance was spent or refunded meanwhile")).toBeVisible({ timeout: 20_000 })
})

// the next spend reaches the service, whose answer is lost on the way back; the bodies sent are kept
async function loseNextSpendAnswer(page: Page, bodies: string[]): Promise<void> {
  let lost = false
  await page.route("**/api/registration/*/spend", async (route) => {
    bodies.push(route.request().postData()!)
    if (lost) return route.continue()
    lost = true
    await route.fetch()
    await route.abort()
  })
}

test("a spend whose answer was lost, its review opened again, names its own order holding the balance and sends the kept body again", async ({ page, request }) => {
  await takenOrder(page, request, uniqueLabel("blost"))
  await page.getByRole("button", { name: "Choose another name" }).click()
  const dearer = sevenLetters()
  await search(page, dearer)
  await toReview(page)
  const bodies: string[] = []
  await loseNextSpendAnswer(page, bodies)
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: "That did not go through" })).toBeVisible()
  // Back and Forward open the review anew, which finds the order the lost answer made
  await page.goBack()
  await page.goForward()
  const own = onStep(page).locator(".line", { hasText: "holds your balance" })
  await expect(own).toHaveText(new RegExp(`^Your order for ${dearer}\\.simplex holds your balance until \\d\\d:\\d\\d\\. Press Pay \\$100 with Bitcoin to open it\\.$`))
  await expect(payButton(page)).toBeEnabled()
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(onStep(page).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  expect(bodies, "the kept body, sent again as it was").toHaveLength(2)
  expect(bodies[1]).toBe(bodies[0])
})

test("Get a new invoice whose spend answer was lost opens the invoice that spend made, rather than calling the balance another order's", async ({ page, request }) => {
  await takenOrder(page, request, uniqueLabel("blni"))
  await page.getByRole("button", { name: "Choose another name" }).click()
  await search(page, sevenLetters())
  await toReview(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const first = new URL(page.url()).searchParams.get("order")!
  await control(request, `expire/${first}`)
  await loseNextSpendAnswer(page, [])
  await onStep(page).getByRole("button", { name: "Get a new invoice" }).click()
  await expect(onStep(page).getByText("That did not go through")).toBeVisible()
  await onStep(page).getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL(otherInvoice(first))
  await expect(onStep(page).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(onStep(page).getByText(/in use by/)).toHaveCount(0)
})

test("a difference order adopted by another browser gets its new invoice as a new spend of the balance, never a plain order for the difference", async ({ page, browser, request }) => {
  const { ownerCode } = await takenOrder(page, request, uniqueLabel("badopt"))
  await page.getByRole("button", { name: "Choose another name" }).click()
  await search(page, sevenLetters())
  await toReview(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const first = new URL(page.url()).searchParams.get("order")!
  // another browser restores the code, then opens the difference order's link, which it adopts without its balance
  const other = await browser.newContext()
  const away = await other.newPage()
  await addNameCode(away, ownerCode)
  await away.goto(`/?order=${first}`)
  await expect(onStep(away).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await control(request, `expire/${first}`)
  await onStep(away).getByRole("button", { name: "Get a new invoice" }).click()
  await away.waitForURL(otherInvoice(first))
  await expect(onStep(away).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  const next = await invoiceOf(away, new URL(away.url()).searchParams.get("order")!)
  expect([next.amount, next.registration.price, next.registration.fromBalance]).toEqual([10000, 20000, 10000])
  await other.close()
})
