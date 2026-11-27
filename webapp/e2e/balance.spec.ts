import { expect, type Locator, type Page } from "@playwright/test"
import { type Hex, recoverMessageAddress } from "viem"
import { bitcoinPayee, devReceiving } from "../dev/mock/addresses.ts"
import { heldPrice, LOCAL } from "../src/config.ts"
import { MAX_LABEL_LENGTH } from "../src/names.ts"
import {
  addNameCode, bitcoinRefundOf, BUYER_BITCOIN, FIT_SIZES, keepOrder, MOCK, onStep, registrationOf, sevenLetters, shot, supportRefunds, takenOrder, registrationView, test, uniqueLabel,
} from "./helpers.ts"

const balanceRow = (page: Page) => onStep(page).locator(".list-row[data-key^='balance-']")
const WITH_PROOF = "Copy the order reference and address proof for support"
const REQUEST_WITH_PROOF = "Copy the refund request and address proof for support"
const SEND = "Please contact support via chat@simplex.chat or SimpleX, and send this refund request."
const SEND_FOR_ADDRESS = (coin: string) => `Please enter your ${coin} address, then contact support via chat@simplex.chat or SimpleX, and send the refund request shown under it.`
const MAINNET_BITCOIN = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
const signedLine = (reference: string, cents: number, destination: string) => new RegExp(`^refund ${reference} ${cents} ${destination} \\d+ 0x[0-9a-f]{130}$`)

async function refundLine(popup: Locator): Promise<string> {
  const line = popup.locator(".copy-field .word")
  await expect(line).toHaveText(/^refund /)
  return (await line.textContent())!
}

// Your names, its rows read
async function yourNames(page: Page): Promise<void> {
  await page.goto("/#/names")
  await expect(onStep(page).getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(onStep(page).locator(".chip", { hasText: "Checking" })).toHaveCount(0)
}

// whether a row's actions stand beside its words rather than under them, and how far their middle is from the row's
const actionsBeside = (row: Locator) => row.evaluate((r) => {
  const [box, words, acts] = [r, r.querySelector(".main")!, r.querySelector(".acts")!].map((n) => n.getBoundingClientRect())
  return { beside: acts.left >= words.right, offMiddle: Math.round(Math.abs((acts.top + acts.bottom) / 2 - (box.top + box.bottom) / 2)) }
})

// The least room between a line of a row's words, as drawn, and a chip or action level with it; Infinity when none is.
const wordsRoom = (row: Locator) => row.evaluate((r) => {
  const range = document.createRange()
  range.selectNodeContents(r.querySelector(".main")!)
  const words = [...range.getClientRects()]
  const beside = [...r.querySelectorAll(":scope > .state, :scope > .acts > *")].map((n) => n.getBoundingClientRect()).filter((b) => b.width > 0)
  const level = words.flatMap((w) => beside.filter((b) => Math.min(w.bottom, b.bottom) > Math.max(w.top, b.top)).map((b) => b.left - w.right))
  return Math.round(Math.min(Infinity, ...level))
})
// the windows a balance row is drawn in: a laptop's and three phones', down to the narrowest
const ROW_SIZES = [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 360, height: 780 }, { width: 320, height: 640 }]
// the room a list row keeps between its parts (styles.css .list-row .acts)
const ROW_GAP = 14

test("a paid order taken first keeps its price as its balance, which support refunds to the address in a request signed with its name key", async ({ page, request }) => {
  const label = sevenLetters()
  const { invoiceId } = await takenOrder(page, request, label)
  await expect(onStep(page).getByRole("button", { name: WITH_PROOF }), "the taken order's page gives support its address proof").toBeVisible()
  await yourNames(page)
  await expect(balanceRow(page)).toHaveCount(1)
  await expect(balanceRow(page).locator(".main")).toHaveText(`$200From ${label}.simplex, someone has taken this name`)
  // the order taken first is no name of this browser's: its balance alone stands for it
  await expect(onStep(page).locator(".list-row", { hasText: `${label}.simplex` })).toHaveCount(1)
  await shot(page, "B1-names-balance")
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    expect(await actionsBeside(balanceRow(page)), `Refund beside the balance's words, centred on its row, at ${size.width}x${size.height}`).toEqual({ beside: true, offMiddle: 0 })
  }
  await page.setViewportSize(FIT_SIZES[0])

  await expect(balanceRow(page).getByRole("button", { name: "Refund" })).toHaveAttribute("aria-haspopup", "dialog")
  await balanceRow(page).getByRole("button", { name: "Refund" }).click()
  const popup = page.getByRole("dialog", { name: "Refund" })
  await expect(popup).toContainText(`${SEND_FOR_ADDRESS("Bitcoin")} Support refunds $200 in Bitcoin to your address.`)
  const address = popup.getByRole("textbox", { name: "Your Bitcoin address" })
  await expect(address).toBeFocused()
  await expect(popup.locator(".copy-field")).toHaveCount(0)
  for (const other of ["card", MAINNET_BITCOIN, LOCAL.moneroPrimaryAddresses[0], BUYER_BITCOIN.slice(0, -1)]) {
    await address.fill(other)
    await expect(popup.locator(".copy-field"), other).toHaveCount(0)
  }
  await address.fill(BUYER_BITCOIN)
  const line = await refundLine(popup)
  expect(line).toMatch(signedLine(invoiceId, 20000, BUYER_BITCOIN))
  await expect(popup.getByRole("button", { name: REQUEST_WITH_PROOF })).toBeVisible()
  await shot(page, "B2-refund")
  await popup.getByRole("button", { name: "Close" }).click()
  await expect(balanceRow(page).getByRole("button", { name: "Refund" })).toBeFocused()
  expect(await supportRefunds(request, line)).toEqual({ registrationId: await registrationOf(request, invoiceId), cents: 20000, destination: BUYER_BITCOIN })
  await page.reload()
  await expect(balanceRow(page).locator(".main")).toHaveText(`$0From ${label}.simplex, someone has taken this name · refunded $200 by support`)
})

test("the copied refund request of an order paid to an address contains the address proof under it", async ({ page, context, request, browserName }) => {
  test.skip(browserName !== "chromium", "reads the clipboard, which Playwright grants in Chromium")
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const label = uniqueLabel("bproof")
  const { invoiceId } = await takenOrder(page, request, label)
  const { addressProof } = await (await request.get(`${MOCK}/control/invoice/${invoiceId}`)).json() as { addressProof: unknown }
  await onStep(page).getByRole("button", { name: "Get a refund" }).click()
  const popup = page.getByRole("dialog", { name: "Refund" })
  await popup.getByRole("textbox", { name: "Your Bitcoin address" }).fill(BUYER_BITCOIN)
  const line = await refundLine(popup)
  await popup.getByRole("button", { name: REQUEST_WITH_PROOF }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${line}\nAddress proof ${JSON.stringify(addressProof)}`)
})

test("the refund of a card order taken first is requested on its page for the card, and support records it on that signed request", async ({ page, request }) => {
  const { invoiceId } = await takenOrder(page, request, uniqueLabel("bcard"), "card")
  await onStep(page).getByRole("button", { name: "Get a refund" }).click()
  const popup = page.getByRole("dialog", { name: "Refund" })
  await expect(popup).toContainText(`${SEND} Support refunds $100 to the card you paid with.`)
  await expect(popup.getByRole("textbox")).toHaveCount(0)
  await expect(popup.getByRole("button", { name: "Copy refund request" })).toBeFocused()
  const line = await refundLine(popup)
  expect(line).toMatch(signedLine(invoiceId, 10000, "card"))
  expect(await supportRefunds(request, line)).toEqual({ registrationId: await registrationOf(request, invoiceId), cents: 10000, destination: "card" })
})

test("the refund of a Monero order taken first is requested on its page for a Monero address of the page's network, and support records it on that signed request", async ({ page, request }) => {
  const { invoiceId } = await takenOrder(page, request, uniqueLabel("bxmr"), "xmr")
  await onStep(page).getByRole("button", { name: "Get a refund" }).click()
  const popup = page.getByRole("dialog", { name: "Refund" })
  await expect(popup).toContainText(`${SEND_FOR_ADDRESS("Monero")} Support refunds $100 in Monero to your address.`)
  const address = popup.getByRole("textbox", { name: "Your Monero address" })
  await expect(address).toBeFocused()
  const monero = LOCAL.moneroPrimaryAddresses[0]
  for (const other of [BUYER_BITCOIN, `${monero.slice(0, -1)}${monero.endsWith("1") ? "2" : "1"}`]) {
    await address.fill(other)
    await expect(popup.locator(".copy-field"), other).toHaveCount(0)
  }
  await address.fill(monero)
  const line = await refundLine(popup)
  expect(line).toMatch(signedLine(invoiceId, 10000, monero))
  expect(await supportRefunds(request, line)).toEqual({ registrationId: await registrationOf(request, invoiceId), cents: 10000, destination: monero })
})

test("the name code shows the balance in another browser, and a refund support records shows as refunded, after which no name is selected for the order", async ({ page, browser, request }) => {
  const label = uniqueLabel("bref")
  const { invoiceId, ownerCode } = await takenOrder(page, request, label)
  const kept = `$100From ${label}.simplex, someone has taken this name`
  const other = await browser.newContext()
  const restored = await other.newPage()
  await addNameCode(restored, ownerCode)
  await expect(onStep(restored).locator(".list-row[data-key^='balance-'] .main")).toHaveText(kept)
  await expect(onStep(restored).locator(".list-row[data-key^='balance-']").getByRole("button", { name: "Refund" })).toBeVisible()
  await other.close()

  await supportRefunds(request, await bitcoinRefundOf(page, invoiceId, 10000))
  await yourNames(page)
  await expect(balanceRow(page).locator(".main")).toHaveText(`$0From ${label}.simplex, someone has taken this name · refunded $100 by support`)
  await expect(balanceRow(page).getByRole("button")).toHaveCount(0)

  await page.goto(`/?order=${invoiceId}`)
  await expect(onStep(page).locator(".notice", { hasText: "What you paid went to your balance." })).toHaveText("What you paid went to your balance. It has been refunded since; Your names shows it.")
  await expect(onStep(page).getByText("Get a refund")).toHaveCount(0)
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#/?name=")
})

// the service worker of a production build answers these pages before Playwright's routes in WebKit
test.describe(() => {
  test.use({ serviceWorkers: "block" })
  test("the refund of a paid order whose registration failed is requested on its page for its price and its balance, or, once its month ended, for the balance its price went to", async ({ page }) => {
    const order = await keepOrder(page, "reg-failref", "inv-failref", "failref")
    const price = heldPrice(order.label.length)
    const failed = (reason: string, balance: { amount: number; refunded: number }) =>
      registrationView(order, { phase: { type: "failed", reason }, commitTx: "0x02", price, balance })
    let view = failed("registryRefused", { amount: 2500, refunded: 0 })
    const expiresAt = new Date(Date.now() - 1000).toISOString()
    await page.route("**/api/registration/reg-failref*", (route) => route.fulfill({ json: view }))
    await page.route("**/api/invoice/inv-failref*", (route) => route.fulfill({ json: { invoiceId: "inv-failref", status: "paid", amount: price, currency: "usd",
      expiresAt, kind: "name", registration: view, cryptoCurrency: "btc", cryptoAmount: "0.00156", ...bitcoinPayee(devReceiving, LOCAL.bitcoinHrp, 0),
      cryptoAmountPaid: "0.00156", cryptoAmountDue: "0", paidInFull: true } }))
    const opened = async () => {
      await page.goto("/#/trademarks")
      await page.goto("/?order=inv-failref")
      await expect(onStep(page).getByRole("heading", { name: "Paid, not registered" })).toBeVisible()
    }
    for (const [reason, balance, cents] of [["registryRefused", 2500, price + 2500], ["monthEnded", price, price]] as const) {
      view = failed(reason, { amount: balance, refunded: 0 })
      await opened()
      await onStep(page).getByRole("button", { name: "Get a refund" }).click()
      const popup = page.getByRole("dialog", { name: "Refund" })
      await popup.getByRole("textbox", { name: "Your Bitcoin address" }).fill(BUYER_BITCOIN)
      const line = await refundLine(popup)
      expect(line, reason).toMatch(signedLine("inv-failref", cents, BUYER_BITCOIN))
      const [, , , , timestamp, signature] = line.split(" ")
      const message = `simplex.domains order inv-failref refund ${cents} ${BUYER_BITCOIN} ${timestamp}`
      expect(await recoverMessageAddress({ message, signature: signature as Hex }), reason).toBe(order.owner)
    }
    const monthEnded = onStep(page).locator(".notice", { hasText: "Your payment is in your balance." })
    await expect(monthEnded).toContainText("Please choose another name, or for a refund, choose Get a refund.")
    view = failed("monthEnded", { amount: 0, refunded: price })
    await opened()
    await expect(onStep(page).getByRole("button", { name: "Get a refund" }), "a balance refunded already").toHaveCount(0)
    await expect(monthEnded).toContainText("Please choose another name, or for a refund, contact support via chat@simplex.chat or SimpleX, with the name and the order reference inv-failref.")
  })

  test(`a balance of a name of ${MAX_LABEL_LENGTH} wide letters keeps its words clear of its Refund, beside it or above, down to a 320 px phone`, async ({ page }) => {
    const order = await keepOrder(page, "reg-balrow", "inv-balrow", "w".repeat(MAX_LABEL_LENGTH))
    const view = registrationView(order, { phase: { type: "taken" }, commitTx: "0x02", balance: { amount: 10000, refunded: 0 } })
    await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: { type: "not_found" } }))
    await page.route("**/api/config", (route) => route.continue())
    await page.route("**/api/registration/reg-balrow*", (route) => route.fulfill({ json: view }))
    await page.route("**/api/invoice/inv-balrow*", (route) => route.fulfill({ json: { invoiceId: "inv-balrow", status: "paid", amount: 10000, currency: "usd",
      expiresAt: new Date(Date.now() - 1000).toISOString(), kind: "name", registration: view, cryptoCurrency: "btc", cryptoAmount: "0.00156", address: "bcrt1q", paidInFull: true } }))
    for (const size of ROW_SIZES) {
      await page.setViewportSize(size)
      await page.goto("/#/trademarks")
      await page.goto("/#/names")
      await expect(balanceRow(page)).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      expect(await wordsRoom(balanceRow(page)), `the room between the words and what is level with them at ${size.width}x${size.height}`).toBeGreaterThanOrEqual(ROW_GAP)
      if (size.width >= ROW_SIZES[1].width) expect(await actionsBeside(balanceRow(page)), `Refund beside the words at ${size.width}x${size.height}`).toEqual({ beside: true, offMiddle: 0 })
    }
  })
})
