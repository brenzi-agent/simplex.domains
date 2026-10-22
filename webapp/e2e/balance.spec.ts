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
  await expect(balanceRow(page).locator(".sub")).toContainText("in use by an open invoice until")
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
