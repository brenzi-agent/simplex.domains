import { expect, type Locator } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { checksumAddress } from "../src/crypto/wallet.ts"
import { dateOf } from "../src/format.ts"
import {
  channelLink, CHECKOUT_KEY, checkoutCode, checkoutOwnerCode, CODE_HEADING, contactLink, control, LINKS_HEADING, MOCK, mockRegistration, onStep, openCode, payButton, REGISTRATION_MS,
  registrationOf, SAVED, savedToReview, search, searchName, shot, startOrder, test, toCodeStep, toReview, uniqueLabel, waitRegistered,
} from "./helpers.ts"

// a field's focus ring reaches 4 px past it, and keeps clear of the label over it
const RING_ROOM_PX = 6

// a stage's drawn line: where the bar's gradient turns from the fill to the track; null for a stage the page has just
// replaced, which has no style left to read
const drawnFill = (stage: Locator) => stage.evaluate((node) => {
  if (node.classList.contains("done")) return 1
  const stops = getComputedStyle(node, "::before").backgroundImage.match(/[\d.]+%/g)
  return stops ? parseFloat(stops[1]) / 100 : null
})

test("the wait's line fills as the wait goes, and is full when it ends", async ({ page, request }) => {
  // each wait stage drawn, as it is first attached: whether its fill is set before it can paint
  await page.addInitScript(() => {
    const w = window as unknown as { __fills: string[] }
    w.__fills = []
    new MutationObserver((changes) => {
      for (const node of changes.flatMap((c) => [...c.addedNodes])) {
        if (!(node instanceof Element)) continue
        const stages = [...node.querySelectorAll<HTMLElement>(".stage.active")].filter((s) => s.textContent?.includes("Waiting"))
        for (const stage of stages) w.__fills.push(stage.style.getPropertyValue("--done"))
      }
    }).observe(document, { childList: true, subtree: true })
  })
  const { invoiceId } = await startOrder(page, uniqueLabel("fill"), { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  const wait = page.locator("body > main .stage", { hasText: "Waiting" })
  await expect(wait).toHaveClass(/\bactive\b/, { timeout: REGISTRATION_MS })
  const filled = () => drawnFill(wait)
  const first = (await filled())!
  expect(first, "the line starts short of full").toBeLessThan(1)
  const fills = await page.evaluate(() => (window as unknown as { __fills: string[] }).__fills)
  expect(fills.length, "the wait stage was drawn").toBeGreaterThan(0)
  expect(fills.filter((f) => f === ""), `every wait stage is drawn with its fill set: ${fills}`).toEqual([])
  await expect.poll(filled, { message: "the line fills as the wait goes" }).toBeGreaterThan(first)
  await page.locator(".countdown b > svg").waitFor({ timeout: REGISTRATION_MS })
  await expect.poll(filled, { message: "the line is full when the wait ends" }).toBe(1)
})

test("a stage with no timed wait, as the register transaction being mined, draws no fill", async ({ page, request }) => {
  const label = uniqueLabel("mined")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `Registering ${label}.simplex` })).toBeVisible({ timeout: REGISTRATION_MS })
  // the order is held at its register transaction, whatever the chain does meanwhile
  await page.route(`**/api/invoice/${invoiceId}*`, async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    await route.fulfill({ response, json: { ...json, registration: { ...json.registration, phase: "registering" } } })
  })
  await page.reload()
  const mined = page.locator("body > main .stage.active")
  await expect(mined).toContainText("Registering")
  expect(await drawnFill(mined), "the untimed stage's drawn fill").toBe(0)
  await page.unrouteAll({ behavior: "wait" })
})

test("a Bitcoin order pays in two parts, registers on chain, takes its links on Edit links, and the code owns it", async ({ page, request }) => {
  const label = uniqueLabel("btc")
  const contact = contactLink("A1")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc", shots: "N3" })
  expect(ownerCode).toMatch(/^SN-/)

  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(onStep(page).locator(".card.qr svg")).toBeVisible()
  await expect(page.getByText(/Rate held \d+:\d\d/)).toBeVisible()
  await shot(page, "N4-bitcoin")
  // the wallet link is a BIP21 URI for what is left to send, and each copy button says what it copies
  const invoice = async () => (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as Promise<{ address: string; cryptoAmount: string; cryptoAmountDue: string }>
  const wallet = onStep(page).getByRole("link", { name: "Open in wallet" })
  const { address, cryptoAmount } = await invoice()
  await expect(wallet).toHaveAttribute("href", `bitcoin:${address}?amount=${cryptoAmount}`)
  await expect(onStep(page).getByRole("button", { name: "Copy amount in BTC" })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Copy Bitcoin address" })).toBeVisible()

  await control(request, `partial/${invoiceId}`)
  await expect(page.getByText("Part of the payment arrived")).toBeVisible()
  const { cryptoAmountDue } = await invoice()
  expect(cryptoAmountDue, "the rest is less than the whole").not.toBe(cryptoAmount)
  await expect(wallet).toHaveAttribute("href", `bitcoin:${address}?amount=${cryptoAmountDue}`)
  await expect(onStep(page).getByRole("button", { name: "Copy rest to send in BTC" })).toBeVisible()
  await shot(page, "N4a-partial")

  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `Registering ${label}.simplex` })).toBeVisible()
  await expect(page.locator(".stage.done", { hasText: "Committed" })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(".countdown b")).toHaveText(/\d+:\d\d/)
  await shot(page, "N6a-waiting")
  await waitRegistered(page, label)
  await expect(page.getByTestId("owner-code"), "the code to redeem in the app").toHaveText(ownerCode)
  await shot(page, "N7-registered")

  const answer = await searchName(request, label)
  expect(answer.status).toBe("registered")
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
  expect(answer.records, "a name whose links were skipped is registered with none").toEqual({ contact: "", channel: "" })
  const registrationId = await registrationOf(request, invoiceId)

  // edit links: both links, signed in the page, sent by the mock's relayer
  await page.goto(`/#/edit/${registrationId}`)
  await expect(page.getByLabel("Address")).toHaveValue("")
  const labelRoom = await page.locator(".link-field").evaluateAll((fields) => fields.map((f) => f.querySelector(".field")!.getBoundingClientRect().top - f.previousElementSibling!.getBoundingClientRect().bottom))
  expect(Math.min(...labelRoom), "room between each label and its field's focus ring").toBeGreaterThanOrEqual(RING_ROOM_PX)
  await page.getByLabel("Address").fill(contact)
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  const channel = channelLink("B2")
  await page.getByLabel("Channel").fill(channel)
  await expect(page.locator(".link-field").nth(1)).toHaveAttribute("data-state", "ok")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  // Save stays off with nothing left to save, so focus goes to the answer below it, which stays in view
  const saved = page.locator(".notice", { hasText: "Links saved" })
  await expect(saved).toBeFocused()
  await expect(saved).toBeInViewport()
  await shot(page, "N12b-edit-links")
  expect((await searchName(request, label)).records).toEqual({ contact, channel })

  await page.goto(`/#/?name=${label}`)
  await expect(page.locator(".answer .entity", { hasText: "Contact A1Y8m3" })).toBeVisible()
  await expect(page.locator(".answer .chip", { hasText: "Yours" })).toBeVisible()
  await shot(page, "N2a-taken-own")
  await page.goto(`/#/edit/${registrationId}`)
  await expect(page.getByLabel("Address")).toHaveValue(contact)

  // a rate-limited edit keeps Save off for the wait it was given, whatever is typed meanwhile
  await page.route("**/api/name/records", (route) => route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await page.getByLabel("Address").fill("")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await page.getByLabel("Address").fill(contact)
  await page.getByLabel("Address").fill("")
  await expect(page.getByRole("button", { name: "Save links" })).toBeDisabled()
  await page.unroute("**/api/name/records")
  await expect(page.getByRole("button", { name: "Save links" })).toBeEnabled({ timeout: 10_000 })

  // a second edit spends the next resolver nonce
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact: "", channel })

  // links are sent one at a time, so a refusal after the first says which one is on chain
  const nextChannel = channelLink("C3")
  let sent = 0
  await page.route("**/api/name/records", (route) => ++sent === 1 ? route.continue() : route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await page.getByLabel("Address").fill(contact)
  await page.getByLabel("Channel").fill(nextChannel)
  await expect(page.locator(".link-field").nth(1)).toHaveAttribute("data-state", "ok")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.locator("[aria-hidden=true]", { hasText: /^The address was saved; the channel was not\. Try again in/ })).toBeVisible({ timeout: 30_000 })
  await page.unroute("**/api/name/records")
  await expect(page.getByRole("button", { name: "Save links" })).toBeEnabled({ timeout: 10_000 })
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact, channel: nextChannel })

  const nonceMoved = (ahead: number, records?: { contact: string; channel: string }) => page.route(/\/api\/name\/(0x)?[0-9a-f]{64}/, async (route) => {
    const res = await route.fetch()
    const json = await res.json() as { recordsNonce: number }
    await route.fulfill({ response: res, json: { ...json, recordsNonce: json.recordsNonce + ahead, ...(records ? { records } : {}) } })
  })
  const refusedChannel = channelLink("D4")
  sent = 0
  await page.route("**/api/name/records", (route) => ++sent === 1 ? route.continue() : route.fulfill({ status: 400, json: { error: "bad_request" } }))
  await nonceMoved(1)
  await page.getByLabel("Address").fill("")
  await page.getByLabel("Channel").fill(refusedChannel)
  await expect(page.locator(".link-field").nth(1)).toHaveAttribute("data-state", "ok")
  await page.getByRole("button", { name: "Save links" }).click()
  const partly = page.getByText("Another save reached the chain first. The channel is still as you typed it: save again to send it.")
  await expect(partly).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel("Address")).toHaveValue("")
  await expect(page.getByLabel("Channel")).toHaveValue(refusedChannel)
  await page.unroute(/\/api\/name\/(0x)?[0-9a-f]{64}/)

  await nonceMoved(2, { contact, channel: nextChannel })
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("An earlier save got there first")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel("Address")).toHaveValue(contact)
  await expect(page.getByLabel("Channel")).toHaveValue(nextChannel)
  await expect(page.locator(".link-field").first().locator(".entity:not(.skeleton)")).toBeVisible()
  await expect(page.locator(".link-field").nth(1).locator(".entity:not(.skeleton)")).toBeVisible()
  await expect(page.getByText("An earlier save got there first")).toBeVisible()
  await page.unroute(/\/api\/name\/(0x)?[0-9a-f]{64}/)
  await page.unroute("**/api/name/records")

  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip")).toHaveText("Registered")
  await shot(page, "N12-history")
  // Show code opens the name code in its own row, focus staying on the toggle, which folds it again
  await row.getByRole("button", { name: "Show code" }).focus()
  await page.keyboard.press("Enter")
  await expect(row.locator(".row-code .code-text")).toHaveText(ownerCode)
  await expect(row.locator(".row-code svg.qr")).toBeVisible()
  await expect(row.getByRole("button", { name: "Hide code" })).toBeFocused()
  await shot(page, "N12g-history-code")
  await page.keyboard.press("Enter")
  await expect(row.locator(".row-code")).toHaveCount(0)
  await expect(row.getByRole("button", { name: "Show code" })).toBeFocused()

  await row.getByText("Edit links").click()
  await expect(page.getByLabel("Channel")).toHaveValue(nextChannel)
  await page.getByLabel("Address").fill(contact)
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
})

test("a purchase walks the steps a buyer expects, and the links set before paying are on chain", async ({ page, request }) => {
  const label = uniqueLabel("flow")
  const [contact, channel] = [contactLink("F1"), channelLink("G1")]
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)

  await expect(step.getByRole("heading", { name: "What should your name open?" })).toBeFocused()
  await expect(step.locator(".lead")).toHaveText(`When someone opens ${label}.simplex in SimpleX, it connects them to you or shows your channel. Paste the links from the app; you can change them later.`)
  await expect(step.getByRole("button", { name: "Skip for now" })).toBeVisible()
  await step.getByLabel("Address").fill(contact)
  await expect(step.getByRole("button", { name: "Skip for now" }), "a typed link leaves only Continue").toHaveCount(0)
  await step.getByLabel("Channel").fill(channel)
  for (const field of await step.locator(".link-field").all()) {
    await expect(field).toHaveAttribute("data-state", "ok")
    await expect(field.locator(".entity:not(.skeleton)")).toBeVisible()
  }
  await step.getByRole("button", { name: "Continue" }).click()

  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeFocused()
  const ownerCode = await checkoutOwnerCode(page)
  await expect(step.getByTestId("owner-code")).toHaveText(ownerCode)
  expect(await page.evaluate((c) => localStorage.getItem(`simplex-names:pending:${c}`) !== null, ownerCode), "the code is kept in this browser as its step opens").toBe(true)
  await expect(step.getByText(`It is the only key to ${label}.simplex. If you lose it, nothing can recover it.`)).toBeVisible()
  const next = step.getByRole("button", { name: "Continue" })
  await expect(next, "Continue waits for the box").toBeDisabled()
  await step.getByText(SAVED).click()
  await expect(next).toBeEnabled()
  await next.click()

  await expect(step.getByRole("heading", { name: "Check your order" })).toBeFocused()
  // the order, then how it pays, a code instead, and Pay, in one column
  expect(await step.locator(".review > *").evaluateAll((nodes) => nodes.map((n) => n.className))).toEqual(["card summary-card", "pay-with", "field code-link", "pay-block"])
  await expect(step.locator(".summary-card .name")).toHaveText(`${label}.simplex`)
  await expect(step.locator(".summary-card .term-line")).toHaveText(/^2 years \+ 30 days\s·\suntil \d{1,2}\s\w{3} \d{4}$/)
  // each link as the profile it opens, under the links step's own names
  await expect(step.locator(".link-line .k")).toHaveText(["Contact address", "Channel"])
  await expect(step.locator(".link-line .entity .who b")).toHaveText(["Contact F1Y8m3", "Channel G1Rk27"])
  await expect(step.locator(".summary-card .total b")).toHaveText(/^\$[\d,]+\.\d\d$/)
  await expect(step.getByRole("radio")).toHaveText(["Card", "Bitcoin", "Monero"])
  await expect(step.getByRole("checkbox")).toHaveCount(0)

  // Change opens the links with focus in the field chosen; the code saved, Continue returns to the review, its code field
  // still open with what was typed in it
  await openCode(page)
  await checkoutCode(page).fill("SN6-Z6VPA")
  await step.getByRole("button", { name: "Change the channel" }).click()
  await expect(step.getByLabel("Channel")).toBeFocused()
  await expect(step.getByLabel("Channel")).toHaveValue(channel)
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: "Check your order" })).toBeFocused()
  await expect(checkoutCode(page)).toHaveValue("SN6-Z6VPA")
  await checkoutCode(page).fill("")
  // Back walks the same steps in reverse, its box still ticked
  await step.getByRole("link", { name: "Back" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeFocused()
  await expect(step.getByRole("checkbox", { name: SAVED })).toBeChecked()
  await step.getByRole("link", { name: "Back" }).click()
  await expect(step.getByRole("heading", { name: LINKS_HEADING })).toBeFocused()
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: "Check your order" })).toBeFocused()

  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  const invoiceId = new URL(page.url()).searchParams.get("order")!
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `Registering ${label}.simplex` })).toBeVisible({ timeout: REGISTRATION_MS })
  await expect(page.getByTestId("owner-code"), "the code was saved before paying").toHaveCount(0)
  await expect(page.getByRole("checkbox")).toHaveCount(0)

  await waitRegistered(page, label)
  const main = page.locator("body > main")
  await expect(main.locator(".lead")).toHaveText(`Registered until ${dateOf((await searchName(request, label)).expiresAt as number)}.`)
  // the code to redeem in the app, beside its QR, with no box to tick
  await expect(main.locator(".next-step").getByRole("heading", { name: "Redeem it in the app" })).toBeVisible()
  await expect(main.locator(".next-step").getByTestId("owner-code")).toHaveText(ownerCode)
  await expect(main.locator(".next-step").getByRole("button", { name: "Copy code" })).toBeVisible()
  await expect(main.getByRole("checkbox")).toHaveCount(0)
  await expect(main.getByRole("link", { name: "Your names" })).toHaveAttribute("href", "/#/names")
  const answer = await searchName(request, label)
  expect(answer.owner, "the code saved before paying owns the name").toBe(checksumAddress(walletOf(ownerCode)!.address))
  expect(answer.records, "the links set before paying are on chain").toEqual({ contact, channel })

  // Your names, opened from here, draws the name as registered from its first frame, never as a row still being checked,
  // and its line as it stays once the name's links are read
  await page.evaluate((name) => {
    const w = window as unknown as { __chips: string[]; __lines: Set<string> }
    w.__chips = []
    w.__lines = new Set()
    new MutationObserver(() => {
      for (const row of document.querySelectorAll(".list-row")) {
        if (!row.textContent!.includes(name)) continue
        w.__chips.push(row.querySelector(".chip")!.textContent!)
        w.__lines.add(row.querySelector(".sub")!.textContent!)
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  }, `${label}.simplex`)
  const nameRead = page.waitForResponse((r) => /\/api\/name\/(0x)?[0-9a-f]{64}/.test(new URL(r.url()).pathname))
  await main.getByRole("link", { name: "Your names" }).click()
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` }).getByRole("button", { name: "Show code" })).toBeVisible()
  await nameRead
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` }).getByRole("button", { name: "Edit links" })).toBeVisible()
  const { chips, lines } = await page.evaluate(() => {
    const w = window as unknown as { __chips: string[]; __lines: Set<string> }
    return { chips: w.__chips, lines: [...w.__lines] }
  })
  expect(chips.filter((chip) => chip !== "Registered"), chips.join(" | ")).toEqual([])
  expect(lines, "the row's line as first drawn").toHaveLength(1)
  await page.goBack()
  await waitRegistered(page, label)
  await main.getByRole("link", { name: "Edit links" }).click()
  await expect(page.getByRole("heading", { name: `Edit links for ${label}.simplex` })).toBeVisible()
  expect(new URL(page.url()).hash).toBe(`#/edit/${await registrationOf(request, invoiceId)}`)
  await expect(page.getByLabel("Address")).toHaveValue(contact)

  // a link of the wrong kind is refused, and Save takes focus to it
  await page.getByLabel("Address").fill("https://smp8.simplex.im/c#notacontact")
  await expect(page.getByText("This is a channel link: paste it in the Channel field.")).toBeVisible()
  await shot(page, "N12f-link-wrong-kind")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByLabel("Address")).toBeFocused()
  // a link preview the service cannot answer now is checked again by itself
  let refused = 0
  await page.route("**/api/link/preview", async (route) => {
    if (refused++ === 0) return route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } })
    return route.continue()
  })
  await page.getByLabel("Address").fill(contactLink("prev"))
  await expect(page.locator(".field-error [aria-hidden=true]", { hasText: /The link could not be checked now/ })).toBeVisible()
  await expect(page.locator(".link-field").first().locator(".entity")).toBeVisible({ timeout: 10_000 })
  await page.unrouteAll({ behavior: "wait" })
})

test("Skip for now shows only while both links are empty, and a link edited keeps its last good value until emptied", async ({ page }) => {
  await search(page, uniqueLabel("skip"))
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  const skip = step.getByRole("button", { name: "Skip for now" })
  const stored = () => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).contact as string, CHECKOUT_KEY)
  const contact = contactLink("S1")
  await step.getByLabel("Address").fill(contact)
  await expect(step.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  await expect(skip, "Skip would drop the typed link").toHaveCount(0)
  expect(await stored()).toBe(contact)
  await step.getByLabel("Address").fill(`${contact}!`)
  await expect(step.locator(".link-field").first()).toHaveAttribute("data-state", "bad")
  expect(await stored(), "a link being edited keeps the last good one").toBe(contact)
  await step.getByLabel("Address").fill("")
  await expect.poll(stored, "a field emptied empties its link").toBe("")
  await expect(skip).toBeVisible()
  await skip.click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeFocused()
  await savedToReview(page)
  await expect(step.locator(".link-line")).toHaveText(["LinksNoneAdd"])
  await step.getByRole("button", { name: "Add links" }).click()
  await expect(step.getByLabel("Address")).toBeFocused()
})

test("Check your order asked for before the name code is saved opens the name code step instead", async ({ page }) => {
  await search(page, uniqueLabel("gate"))
  await toCodeStep(page)
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).saved, CHECKOUT_KEY)).toBe(false)
  await page.goto("/#/checkout")
  await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#/checkout/code")
})

test("Continue on the links step waits for a link being checked, and takes focus to one refused", async ({ page }) => {
  await search(page, uniqueLabel("linkbad"))
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  await step.getByLabel("Channel").fill(contactLink("W1"))
  await expect(step.getByText("This is a contact address link: paste it in the Contact address field.")).toBeVisible()
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByLabel("Channel")).toBeFocused()
  await expect(step.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
})

test("the owner code restores an order in another browser, and a bad code is refused", async ({ page, browser, request }) => {
  const label = uniqueLabel("rest")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "xmr" })
  await expect(page.getByRole("heading", { name: "Pay with Monero" })).toBeVisible()
  const { address, cryptoAmount } = await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as { address: string; cryptoAmount: string }
  await expect(onStep(page).getByRole("link", { name: "Open in wallet" }), "the Monero URI").toHaveAttribute("href", `monero:${address}?tx_amount=${cryptoAmount}`)
  await control(request, `confirming/${invoiceId}`)
  await expect(page.getByText("Waiting for 1 confirmation")).toBeVisible()
  await shot(page, "N5-confirming")
  // the buying browser goes away before the payment settles, so nothing reveals the name
  await page.close()
  await control(request, `settle/${invoiceId}`)

  const other = await browser.newContext()
  const page2 = await other.newPage()
  await page2.goto(`/?order=${invoiceId}`)
  await expect(page2.getByRole("heading", { name: "The name code is not in this browser" })).toBeVisible({ timeout: 60_000 })
  await shot(page2, "N7b-not-here")
  await page2.getByRole("button", { name: "Enter your name code" }).click()

  await page2.getByLabel("Name code").fill("SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")
  await page2.getByRole("button", { name: "Restore" }).click()
  await expect(page2.getByText("This code is not valid")).toBeVisible()
  await shot(page2, "N7c-restore-invalid")

  await page2.getByLabel("Name code").fill(ownerCode.toLowerCase().replaceAll("-", " "))
  await page2.getByRole("button", { name: "Restore" }).click()
  await page2.waitForURL(/\?order=/)
  await waitRegistered(page2, label)
  await expect(page2.getByTestId("owner-code"), "the restored browser holds the code").toHaveText(ownerCode)
  await other.close()
})

test("a card order waits for Stripe, blocks a second card order meanwhile, then registers", async ({ page, request }) => {
  const label = uniqueLabel("card")
  const { invoiceId } = await startOrder(page, label, { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await shot(page, "N10-card")
  await onStep(page).getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  await shot(page, "N10b-card-confirming")

  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("second"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await toReview(page)
  await expect(page.getByText("You have an order waiting to be confirmed")).toBeVisible()
  await expect(payButton(page)).toBeDisabled()
  await shot(page, "N3e-open-card-order")
  await page.getByRole("button", { name: "Open the waiting order" }).click()

  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
})

// The Stripe frame reloads whenever its form is taken out of the page, so the card screen takes another tab's writes in place.
test("the card form stays in place while another tab writes the order, the same record and a changed one", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("cardstay"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await page.evaluate(() => {
    const form = document.querySelector(".stripe")!
    const w = window as unknown as { __moved: number; __parent: Element }
    w.__moved = 0
    w.__parent = form.parentElement!
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) if (n === form || n.contains(form)) w.__moved++
    }).observe(document.body, { childList: true, subtree: true })
  })
  const key = await page.evaluate((id) => Object.keys(localStorage).find((k) => k.startsWith("simplex-names:order:") && localStorage.getItem(k)!.includes(id))!, invoiceId)
  const other = await page.context().newPage()
  await other.goto("/")
  const writes: ((k: string) => void)[] = [
    (k) => localStorage.setItem(k, `${localStorage.getItem(k)!} `),
    (k) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)!), contact: "https://smp8.simplex.im/a#S1" })),
  ]
  for (const write of writes) {
    const read = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/invoice/${invoiceId}` && !r.url().includes("?"))
    await other.evaluate(write, key)
    await read
    await expect(page.locator("main[aria-busy]")).toHaveCount(0)
  }
  expect(await page.evaluate(() => {
    const w = window as unknown as { __moved: number; __parent: Element }
    return { moved: w.__moved, sameParent: document.querySelector(".stripe")?.parentElement === w.__parent }
  })).toEqual({ moved: 0, sameParent: true })
  await expect(onStep(page).getByRole("button", { name: /^Pay \$/ })).toBeEnabled()
  await other.close()
})

test("a cancelled invoice leads back to its name to order again, and expired invoices are replaced and say what arrived", async ({ page, request }) => {
  const label = uniqueLabel("exp")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  const cancels: string[] = []
  page.on("request", (r) => { if (r.url().endsWith("/cancel")) cancels.push(r.url()) })
  await page.getByText("Cancel this invoice").dblclick()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(page.getByText("This invoice was cancelled and nothing was received.")).toBeVisible()
  expect(cancels).toHaveLength(1)
  await shot(page, "N4b-cancelled")

  // nothing is ordered again until the buyer chooses, from the name, how to pay
  await page.getByRole("button", { name: "Order the name again" }).click()
  await expect(page.locator(".answer .card", { hasText: `${label}.simplex` }).getByRole("button", { name: "Register" })).toBeVisible()
  expect(cancels).toHaveLength(1)
  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText("Invoice cancelled")
  const { invoiceId: second } = await startOrder(page, label, { method: "btc" })
  expect(second).not.toBe(invoiceId)
  await control(request, `expire/${second}`)
  await expect(page.getByText("Nothing was received before its rate window closed.")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await shot(page, "N4c-expired")

  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== second)
  const third = new URL(page.url()).searchParams.get("order")!
  await control(request, `partial/${third}`)
  await control(request, `expire/${third}`)
  await expect(page.getByText(/BTC arrived, which is not the full amount/)).toBeVisible()
  await shot(page, "N4d-expired-partial")

  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` }).first().locator(".chip")).toHaveText(/Invoice (expired|cancelled)/)
})

test("a replaced invoice leads to its new order until a late payment reaches it", async ({ page, browser, request }) => {
  const label = uniqueLabel("late")
  const row = (p: typeof page) => p.locator(".list-row:visible", { hasText: `${label}.simplex` })
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "xmr" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await page.goto(`/?order=${invoiceId}`)
  await page.waitForURL((url) => url.searchParams.get("order") === second)
  await page.goto("/#/names")
  await expect(row(page).locator(".chip")).toHaveText(["Waiting for payment"])

  // a browser restored with the code knows only the new order
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restored.goto("/#/restore")
  await restored.getByLabel("Name code").fill(ownerCode)
  await restored.getByRole("button", { name: "Restore" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)

  // the service has forgotten the old invoice; this browser still knows what replaced it
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.goto(`/?order=${invoiceId}`)
  await page.waitForURL((url) => url.searchParams.get("order") === second)
  await page.unroute(`**/api/invoice/${invoiceId}*`)

  await control(request, `settle/${invoiceId}`)
  for (const p of [page, restored]) {
    await p.goto(`/?order=${invoiceId}`)
    await expect(p.getByText("The payment arrived after this invoice had closed")).toBeVisible()
    await expect(p.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
    expect(new URL(p.url()).searchParams.get("order")).toBe(invoiceId)
    await p.goto("/#/names")
    await expect(row(p).locator(".chip")).toHaveText(["Waiting for payment", "Paid late"])
    await expect(row(p).nth(1)).toContainText(`reference ${invoiceId}`)
    await p.goto(`/?order=${invoiceId}`)
    await p.getByRole("button", { name: "Open the new invoice" }).click()
    await p.waitForURL((url) => url.searchParams.get("order") === second)
  }
  await other.close()
})

test("an invoice that received part of its payment and was replaced leads on to the new one once the rest arrives", async ({ page, request }) => {
  const label = uniqueLabel("part")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `partial/${invoiceId}`)
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `settle/${invoiceId}`)
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByText("The payment arrived after this invoice had closed")).toBeVisible()
  await page.goto("/#/names")
  await expect(page.locator(".list-row:visible", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText(["Waiting for payment", "Paid late"])
  await page.goto(`/?order=${invoiceId}`)
  await page.getByRole("button", { name: "Open the new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") === second)
})

test("an invoice that closed while its payment was confirming says a payment reached it, on its page and in Your names", async ({ page, request }) => {
  const label = uniqueLabel("late")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `confirming/${invoiceId}`)
  await control(request, `expire/${invoiceId}`)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(page.getByText("A payment did not complete before the invoice closed.")).toBeVisible()
  await shot(page, "N4e-expired-confirming")
  await page.goto("/#/names")
  const row = page.locator(".list-row:visible", { hasText: `${label}.simplex` })
  await expect(row).toContainText("A payment did not complete before the invoice closed")
  await expect(row.locator(".chip")).toHaveText(["Invoice expired"])
  await shot(page, "N12f-history-expired-paid")
})

test("a browser restored before another browser made a new invoice carries on with that invoice", async ({ page, browser, request }) => {
  const label = uniqueLabel("sib")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restored.goto("/#/restore")
  await restored.getByLabel("Name code").fill(ownerCode)
  await restored.getByRole("button", { name: "Restore" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await page.close()

  await restored.goto(`/?order=${second}`)
  await expect(restored.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  // the adopted order carries the service's time of making it, which later searches for a newer order compare against
  const made = (await mockRegistration(request, second)).createdAt
  const adopted = await restored.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith("simplex-names:order:"))
    .map((k) => JSON.parse(localStorage.getItem(k)!)).find((o: { invoiceId: string }) => o.invoiceId === id), second)
  expect(adopted.createdAt).toBe(made)
  await restored.goto("/#/names")
  await expect(restored.locator(".list-row:visible", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText(["Waiting for payment"])
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await control(request, `settle/${second}`)
  await waitRegistered(restored, label)
  await other.close()
})

// a balanced wrap leaves the lines of a long address within a character or two of each other
const EVEN_LINES = 0.9
test("a long address wraps into even lines on the pay page, on a phone too", async ({ page }) => {
  await startOrder(page, uniqueLabel("xmrwrap"), { method: "xmr" })
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const lines = await page.locator(".copy-field", { hasText: "Monero address" }).locator(".val > span").evaluate((n) => {
      const range = document.createRange()
      range.selectNodeContents(n)
      const rows = new Map<number, number>()
      // the break opportunities between the letters are boxes of no width
      for (const r of [...range.getClientRects()].filter((r) => r.width >= 1)) rows.set(Math.round(r.top), (rows.get(Math.round(r.top)) ?? 0) + r.width)
      return [...rows.values()]
    })
    expect(lines.length, `${width}px: the address breaks`).toBeGreaterThan(1)
    expect(Math.min(...lines) / Math.max(...lines), `${width}px: line widths ${lines.map(Math.round)}`).toBeGreaterThanOrEqual(EVEN_LINES)
  }
})

test("Cancel this invoice reads as working while its request runs, and as itself again once the request fails", async ({ page }) => {
  await startOrder(page, uniqueLabel("cxl"), { method: "btc" })
  let answer!: () => void
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await page.route("**/cancel", async (route) => {
    await answered
    await route.fulfill({ status: 503, json: { error: "provider_unavailable" } })
  })
  const link = onStep(page).locator("a[data-focus=cancel]")
  await link.click()
  await expect(link).toHaveAccessibleName("Cancelling…")
  await expect(link).toHaveAttribute("aria-disabled", "true")
  await expect(link).toBeFocused()
  answer()
  await expect(link).toHaveAccessibleName("Cancel this invoice")
  await expect(link).not.toHaveAttribute("aria-disabled")
  await expect(page.getByText("The invoice could not be cancelled now. Try again in a moment.")).toBeVisible()
})

test("a cancel the service answers with the invoice still open warns not to send more, after a reload too", async ({ page, request }) => {
  const label = uniqueLabel("still")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, "search", { cancelStillOpen: true })
  await page.getByText("Cancel this invoice").click()
  const warning = page.getByText("This invoice was cancelled, but the service still shows it open. Do not send anything more to the address.")
  await expect(warning).toBeVisible()
  await control(request, "search", { cancelStillOpen: false })
  await page.reload()
  await expect(warning).toBeVisible()
  await expect(page.getByText("Cancel this invoice")).toHaveCount(0)
  // money that reached it after the cancel does not make it payable again
  await control(request, `partial/${invoiceId}`)
  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: label }).locator(".chip")).toHaveText("Invoice cancelled")

  // a browser without the order's record keeps nothing, so it warns at once
  const fresh = await page.context().browser()!.newContext()
  const stranger = await fresh.newPage()
  const { invoiceId: other } = await startOrder(page, uniqueLabel("still2"), { method: "xmr" })
  await stranger.goto(`/?order=${other}`)
  await control(request, "search", { cancelStillOpen: true })
  await stranger.getByText("Cancel this invoice").click()
  await expect(stranger.getByText("This invoice was cancelled, but the service still shows it open. Do not send anything more to the address.")).toBeVisible()
  await control(request, "search", { cancelStillOpen: false })
  await fresh.close()
})

test("a restored browser that never opened another browser's newer invoice finds it through the code", async ({ page, browser, request }) => {
  const label = uniqueLabel("newer")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restored.goto("/#/restore")
  await restored.getByLabel("Name code").fill(ownerCode)
  await restored.getByRole("button", { name: "Restore" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  await restored.goto("/#/")
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `settle/${second}`)
  await waitRegistered(page, label)

  // the service has forgotten the old invoice by now; the code still finds the order that replaced it
  await restored.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await restored.unroute(`**/api/invoice/${invoiceId}*`)
  await restored.goto("/#/names")
  await expect(restored.locator(".list-row:visible", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText(["Registered"])
  await other.close()
})

test("a forgotten empty invoice never leads back to the older invoice it replaced", async ({ page, request }) => {
  const label = uniqueLabel("loopb")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  const secondRegistration = await registrationOf(request, second)
  await control(request, `expire/${second}`)
  await control(request, `settle/${invoiceId}`)
  // the service forgets the empty invoice and keeps the late-paid one
  await page.route(`**/api/invoice/${second}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.route("**/api/registration/find", async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { registrations: body.registrations.filter((r: { registrationId: string }) => r.registrationId !== secondRegistration) } })
  })
  await page.goto(`/?order=${second}`)
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("order")).toBe(second)
})

test("a forgotten order whose code's lookup is refused says the link does not work", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("refuse"), { method: "btc" })
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.route("**/api/registration/find", (route) => route.fulfill({ status: 400, json: { error: "bad_request" } }))
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
})

test("a forgotten order whose code's lookup is rate limited waits as asked, then answers", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("limit"), { method: "btc" })
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await control(request, "search", { findLimitSeconds: 2 })
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: "This order could not be loaded" })).toBeVisible()
  // with nothing newer than this order, the lookup ends at the dead link once the limit is over
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible({ timeout: 10_000 })
  await control(request, "search", { findLimitSeconds: 0 })
})

test("an unknown order link says so", async ({ page }) => {
  await page.goto("/?order=nothing-here")
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
  await shot(page, "N11-unknown")
})

test("a card form that does not load says so and offers a new invoice", async ({ page }) => {
  const label = uniqueLabel("nocard")
  const { invoiceId } = await startOrder(page, label, { method: "card" })
  // a configured key makes the page load Stripe.js, which is blocked here
  await page.route(/\/\?order=/, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, body: (await res.text()).replace('name="stripe-publishable-key" content=""', 'name="stripe-publishable-key" content="pk_test_e2e"') })
  })
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.reload()
  await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible()
  await expect(page.getByText("Stripe's form was blocked or failed to load. Nothing was charged.")).toBeVisible()
  await shot(page, "N10a-card-not-loaded")
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible()
  await expect(page.getByText("Stripe's form was blocked or failed to load. Nothing was charged.")).toBeVisible()
})

test("a card form that does not load, in a browser without the order, leads to the name code", async ({ page }) => {
  await startOrder(page, uniqueLabel("nocardrec"), { method: "card" })
  await page.route(/\/\?order=/, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, body: (await res.text()).replace('name="stripe-publishable-key" content=""', 'name="stripe-publishable-key" content="pk_test_e2e"') })
  })
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Get a new invoice" })).toHaveCount(0)
  await page.getByRole("button", { name: "Enter your name code" }).click()
  await expect(page.getByLabel("Name code", { exact: true })).toBeVisible()
})

test("once a name is registered, Back to its search never offers it again, and Your names draws its row registered at once after a reload", async ({ page, request }) => {
  const label = uniqueLabel("mine")
  const { invoiceId } = await startOrder(page, label)
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  // every Register the search draws from here on, however briefly
  await page.evaluate(() => {
    const w = window as unknown as { __offers: number }
    w.__offers = 0
    new MutationObserver(() => {
      if ([...document.querySelectorAll(".answer button")].some((b) => b.textContent!.includes("Register"))) w.__offers += 1
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await page.goBack()
  await expect(page.locator(".answer .chip", { hasText: "Yours" })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __offers: number }).__offers), "draws offering the name again").toBe(0)

  await page.reload()
  await expect(page.locator(".answer .chip", { hasText: "Yours" })).toBeVisible()
  // each chip the name's row is drawn with, from the list's first draw
  await page.evaluate((title) => {
    const w = window as unknown as { __chips: string[] }
    w.__chips = []
    new MutationObserver(() => {
      const row = [...document.querySelectorAll(".list-row")].find((r) => r.querySelector("b")?.textContent === title)
      const chip = row?.querySelector(".chip")?.textContent
      if (chip && w.__chips.at(-1) !== chip) w.__chips.push(chip)
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  }, `${label}.simplex`)
  await page.getByRole("link", { name: "Your names" }).first().click()
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await expect(row.getByRole("button", { name: "Edit links" })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __chips: string[] }).__chips), "the row's chips from its first draw").toEqual(["Registered"])
})
