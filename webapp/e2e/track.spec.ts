import { expect, type Locator, type Page } from "@playwright/test"
import { MAX_LABEL_LENGTH } from "../src/names.ts"
import {
  CHAIN, channelLink, CODE_HEADING, codeField, contactLink, control, fakeRegisteredName, fillLinks, keepOrder, type KeptOrder, LINKS_HEADING, onStep, payButton, previewsShown, SAVED,
  lineStarts, recordedFrames, recordFrames, REGISTRATION_MS, registrationOf, registrationView, savedToReview, search, sevenLetters, shot, startOrder, takenOrder, test, toCodeStep,
  toFullReview, toReview, uniqueLabel, useCode, waitRegistered,
} from "./helpers.ts"

test("the purchase steps swap the whole page, one screen at a time rising in, and Back walks them in reverse", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await search(page, uniqueLabel("swap"))
  const steps: [string, () => Promise<unknown>][] = [
    [LINKS_HEADING, () => page.getByRole("button", { name: "Register" }).click()],
    [CODE_HEADING, () => onStep(page).getByRole("button", { name: "Skip for now" }).click()],
    // the box ticked with a click on its words, which leaves focus where the new step puts it
    ["Check your order", async () => {
      await onStep(page).getByText(SAVED).click()
      await onStep(page).getByRole("button", { name: "Continue" }).click()
    }],
  ]
  for (const [heading, move] of steps) {
    await move()
    await expect(page.getByRole("heading", { name: heading }), `${heading}: its heading takes focus`).toBeFocused()
    await expect(page.locator("body > main > *"), `${heading}: the screens in main`).toHaveCount(1)
    await expect(onStep(page), `${heading}: rises in`).toHaveClass(/\benter\b/)
  }
  for (const heading of [CODE_HEADING, LINKS_HEADING]) {
    await page.goBack()
    await expect(page.getByRole("heading", { name: heading })).toBeVisible()
    await expect(page.locator("body > main > *"), `${heading} again: the screens in main`).toHaveCount(1)
  }
  await page.goBack()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
})

// the sizes a purchase step must fit without scrolling, a laptop's and a phone's
const FIT_SIZES = [{ width: 1280, height: 800 }, { width: 390, height: 844 }]

// Where the heading of the screen in view starts, once it has risen in.
async function headingAt(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))
    const box = document.querySelector("body > main h1")!.getBoundingClientRect()
    return { x: Math.round(box.left), y: Math.round(box.top) }
  })
}

// how far the page reaches past the window, less the footer the badges store keeps below the fold
const overflow = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight - Math.round(document.querySelector("body > footer")!.getBoundingClientRect().height))

interface Frame { heading: number; actions: number | null; button: number | null; link: number | null; back: number | null; investGap: number | null }
type Place = Exclude<keyof Frame, "investGap">
// where the mockup draws a step's heading, its actions' row, its main button, the link under it and Back's word, at each
// window size; a step without a main button keeps its link at the link's place
const MOCKUP_FRAMES: Record<Place, number>[] = [{ heading: 125, actions: 587, button: 587, link: 641, back: 137 }, { heading: 106, actions: 636, button: 636, link: 690, back: 74 }]
// the least room on a laptop between a step's last link and the invest note under it
const INVEST_GAP = 48

// The screen in view fits the window at each size, its content above its actions' row; a step's heading and actions'
// row stand where every step's do, which the caller compares. Captured for review when shots are asked for.
async function fitsWindow(page: Page, name: string, frames?: Record<string, Frame[]>): Promise<void> {
  for (const [i, size] of FIT_SIZES.entries()) {
    await page.setViewportSize(size)
    const measured = () => page.evaluate(() => {
      const shown = document.querySelector("body > main > section")!
      // a step with no action gives its content the action row's room, down to the step's foot; one with only a link,
      // the empty place of a main button above it
      const row = shown.querySelector(":scope > .actions-row")
      const only = row && !row.querySelector(":scope > .btn") ? row.querySelector(":scope > .alt") : null
      const actions = (only ?? row)?.getBoundingClientRect() ?? (shown.classList.contains("step") ? { top: shown.getBoundingClientRect().bottom } : undefined)
      const content = [...shown.querySelectorAll(":scope > .screen-body > *")].map((k) => k.getBoundingClientRect()).filter((b) => b.height > 0)
      const footer = Math.round(document.querySelector("body > footer")!.getBoundingClientRect().height)
      // what is kept whole, as a name's end with its TLD, a price with its term and a name code, drawn on more than one line
      const split = [...shown.querySelectorAll(".nowrap, .deal, .code-text")].filter((n) => new Set([...n.getClientRects()].map((r) => Math.round(r.top))).size > 1)
      return {
        overflow: Math.max(0, document.scrollingElement!.scrollHeight - innerHeight - footer),
        overlap: actions && content.length ? Math.max(0, Math.round(Math.max(...content.map((b) => b.bottom)) - actions.top)) : 0,
        split: split.map((n) => n.textContent),
      }
    })
    await expect.poll(measured, { message: `${name} at ${size.width}x${size.height}` }).toEqual({ overflow: 0, overlap: 0, split: [] })
    if (frames) {
      const at = await page.evaluate(() => {
        const top = (selector: string) => {
          const node = document.querySelector(selector)
          return node ? Math.round(node.getBoundingClientRect().top) : null
        }
        const links = [...document.querySelectorAll("body > main a")].map((a) => a.getBoundingClientRect()).filter((b) => b.height > 0)
        const invest = top("body > .invest p")
        return {
          heading: top("body > main h1")!,
          actions: top("body > main > section > .actions-row"),
          button: top("body > main > section > .actions-row > .btn"),
          link: top("body > main > section > .actions-row > .alt"),
          back: top("body > main .back span"),
          investGap: links.length && invest !== null ? Math.round(invest - Math.max(...links.map((b) => b.bottom))) : null,
        }
      })
      ;(frames[name] ??= [])[i] = at
    }
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, `names-u1-${name}`)
}

// every step's heading, actions' row, main button, link and Back, where it has them, at the mockup's place for each
// window size; on a laptop its last link keeps its room above the invest note
function oneFrame(frames: Record<string, Frame[]>): void {
  for (const [i, size] of FIT_SIZES.entries()) {
    const at = Object.fromEntries(Object.entries(frames).map(([name, f]) => [name, f[i]]))
    const mockup = MOCKUP_FRAMES[i]
    const places = Object.keys(mockup) as Place[]
    const off = Object.entries(at).filter(([, f]) => places.some((place) => f[place] !== null && f[place] !== mockup[place]))
    expect(off, `the steps' heading, actions, button, link and Back at ${size.width}x${size.height}, the mockup's ${JSON.stringify(mockup)}`).toEqual([])
  }
  const cramped = Object.entries(frames).filter(([, f]) => f[0].investGap !== null && f[0].investGap < INVEST_GAP)
  expect(cramped, `the steps' last link at least ${INVEST_GAP} px above the invest note at ${FIT_SIZES[0].width}x${FIT_SIZES[0].height}`).toEqual([])
}

test("every purchase step fits a laptop's and a phone's window, its heading and main button at one place on every step", async ({ page, request }) => {
  await page.goto("/")
  await fitsWindow(page, "1-home")
  // a taken name with both its links
  await search(page, "bakery")
  await expect(page.locator(".answer .chat")).toHaveCount(2)
  await fitsWindow(page, "1b-home-taken")
  const label = uniqueLabel("fit")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  const frames: Record<string, Frame[]> = {}
  await expect(step.getByRole("heading", { name: LINKS_HEADING })).toBeFocused()
  await fitsWindow(page, "2a-links-empty", frames)
  const linksAt = await headingAt(page)
  await fillLinks(page, contactLink("F2"), channelLink("G2"))
  await previewsShown(page)
  expect(await headingAt(page), "the links step as its previews come").toEqual(linksAt)
  await fitsWindow(page, "2-links", frames)
  await backInView(page, "links")
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await fitsWindow(page, "3-code", frames)
  await savedToReview(page)
  await fitsWindow(page, "4-review", frames)
  await backInView(page, "review")
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await fitsWindow(page, "5-pay-bitcoin", frames)
  const invoiceId = new URL(page.url()).searchParams.get("order")
  await control(request, `confirming/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible()
  await fitsWindow(page, "5c-confirming", frames)
  await control(request, `settle/${invoiceId}`)
  await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
  await fitsWindow(page, "6-registering", frames)
  await waitRegistered(page, label)
  await fitsWindow(page, "7-registered", frames)
  await page.goto("/#/code")
  await fitsWindow(page, "8-check-code", frames)
  await startOrder(page, uniqueLabel("fitcard"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await expect(page.locator(".name-check:not(.unchecked)")).toBeVisible()
  await fitsWindow(page, "5b-pay-card", frames)
  oneFrame(frames)
})

test("the balance's steps fit both windows, their heading, main button and link where every step's are", async ({ page, request }) => {
  const frames: Record<string, Frame[]> = {}
  await takenOrder(page, request, uniqueLabel("fitbal"))
  await fitsWindow(page, "b1-taken", frames)
  await page.getByRole("button", { name: "Choose another name" }).click()
  await search(page, uniqueLabel("fitbal2"))
  await toReview(page)
  const register = onStep(page).getByRole("button", { name: "Register with your balance" })
  await expect(register).toBeVisible()
  await fitsWindow(page, "b2-review-balance", frames)
  // another tab's invoice for a dearer name holds the balance, which the review says until that invoice is cancelled
  const other = await page.context().newPage()
  await other.goto("/#/names")
  await other.locator(".list-row[data-key^='balance-']").getByRole("button", { name: "Use" }).click()
  await search(other, sevenLetters())
  await toReview(other)
  await payButton(other).click()
  await other.waitForURL(/\?order=/)
  await register.click()
  await expect(onStep(page).locator(".line", { hasText: "Your balance is in use by" })).toBeVisible()
  await fitsWindow(page, "b2b-review-balance-held", frames)
  await onStep(other).getByRole("button", { name: "Cancel this invoice" }).click()
  await expect(register).toBeEnabled()
  await other.close()
  await search(page, sevenLetters())
  await toReview(page)
  await expect(payButton(page)).toHaveText("Pay $100 with Bitcoin")
  await fitsWindow(page, "b3-review-balance-more", frames)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(page.locator(".name-check:not(.unchecked)")).toBeVisible()
  await fitsWindow(page, "b4-pay-difference", frames)
  oneFrame(frames)
})

const FIT_INVOICE = "inv-fitall"
// an invoice of a kept order, as the service answers it, for a page to draw
const invoiceOf = (o: KeptOrder, status: string, reg: Record<string, unknown>, change: Record<string, unknown> = {}) => ({
  invoiceId: FIT_INVOICE, status, amount: 10000, currency: "usd", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), kind: "name", registration: registrationView(o, reg),
  cryptoCurrency: "btc", cryptoAmount: "0.00156", address: "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s", ...change,
})
// the money that reached an invoice short of its amount
const PART = { cryptoAmountPaid: "0.0005", cryptoAmountDue: "0.00106", paidInFull: false }

// the service worker of a production build answers these pages before Playwright's routes in WebKit
test.describe(() => {
  test.use({ serviceWorkers: "block" })

  test(`every outcome and refusal of an order fits both windows for a name of ${MAX_LABEL_LENGTH} wide letters, its heading and main button where every step's are`, async ({ page, browser, request }) => {
    const label = wideLabel(MAX_LABEL_LENGTH)
    const frames: Record<string, Frame[]> = {}
    const order = await keepOrder(page, "reg-fitall", FIT_INVOICE, label)
    let invoice = invoiceOf(order, "open", {}, PART)
    await page.route(`**/api/invoice/${FIT_INVOICE}*`, (route) => route.fulfill({ json: invoice }))
    await page.route("**/api/registration/reg-fitall*", (route) => route.fulfill({ json: invoice.registration }))
    const shown = async (name: string, next: typeof invoice, heading: string | RegExp) => {
      invoice = next
      await page.goto("/#/trademarks")
      await page.goto(`/?order=${FIT_INVOICE}`)
      await expect(onStep(page).getByRole("heading", { name: heading })).toBeVisible()
      await fitsWindow(page, name, frames)
    }
    await shown("o1-partial-bitcoin", invoice, "Pay with Bitcoin")
    await shown("o2-closed-part-paid", invoiceOf(order, "expired", {}, PART), "Invoice closed")
    await shown("o2b-paid-late", invoiceOf(order, "paid", { balance: { amount: 10000, held: false, heldUntil: null, refunded: 0 } }), "Invoice closed")
    await expect(onStep(page).getByRole("button", { name: "Get a refund" })).toBeVisible()
    await shown("o3-paid-not-registered", invoiceOf(order, "paid", { phase: "failed", commitTx: "0x02", error: "The registration transaction reverted on chain" }), "Paid, not registered")
    await page.route("**/api/registration/reg-fitall/retry", (route) => route.fulfill({ status: 500, json: { error: "internal" } }))
    await onStep(page).getByRole("button", { name: "Try again" }).click()
    await expect(onStep(page).getByText("That did not go through")).toBeVisible()
    await fitsWindow(page, "o3b-not-registered-retry-refused", frames)
    await shown("o4-taken", invoiceOf(order, "paid", { phase: "taken", commitTx: "0x02", balance: { amount: 10000, held: false, heldUntil: null, refunded: 0 } }), /was taken$/)
    await expect(onStep(page).getByRole("button", { name: "Get a refund" })).toBeVisible()
    // a taken order seen in a browser without its code, which says where to add the code
    const elsewhere = await browser.newContext()
    const stranger = await elsewhere.newPage()
    await stranger.route(`**/api/invoice/${FIT_INVOICE}*`, (route) => route.fulfill({ json: invoiceOf(order, "paid", { phase: "taken", commitTx: "0x02" }) }))
    await stranger.goto(`/?order=${FIT_INVOICE}`)
    await expect(onStep(stranger).getByText("The name code is not in this browser")).toBeVisible()
    await fitsWindow(stranger, "o5-taken-without-code", frames)
    await elsewhere.close()

    // Check your order turning down a code and a method, then the price changed and too many attempts
    const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
    await useCode(page, code)
    await search(page, label)
    await toReview(page)
    await page.route("**/api/name/register", (route) => route.fulfill({ status: 400, json: { error: "code_used" } }))
    await onStep(page).getByRole("button", { name: "Register with your code" }).click()
    await expect(onStep(page).getByText("This code was already used.")).toBeVisible()
    await page.getByRole("radio", { name: "Card" }).click()
    await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "provider_unavailable" } }) : route.continue())
    await payButton(page).click()
    await expect(onStep(page).getByText("Card is temporarily unavailable")).toBeVisible()
    await fitsWindow(page, "o6-review-code-and-method-refused", frames)
    await page.unroute("**/api/invoice")
    await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 409, json: { error: "catalog_changed", price: 12345 } }) : route.continue())
    await payButton(page).click()
    await expect(onStep(page).getByRole("heading", { name: "The price changed" })).toBeVisible()
    await fitsWindow(page, "o7-price-changed", frames)
    // the review opened again takes the new price
    await page.reload()
    await page.unroute("**/api/invoice")
    await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "60" }, json: { error: "rate_limited" } }) : route.continue())
    await payButton(page).click()
    await expect(onStep(page).getByRole("heading", { name: "Too many attempts" })).toBeVisible()
    await fitsWindow(page, "o8-too-many", frames)
    oneFrame(frames)
  })
})

test(`Edit links fits both windows with its answer, for a name of ${MAX_LABEL_LENGTH} wide letters`, async ({ page }) => {
  const label = wideLabel(MAX_LABEL_LENGTH)
  const links = { contact: contactLink("E1"), channel: channelLink("E2") }
  // the chain moves on to a newer save as this one is refused
  let saved = 0
  const { registrationId } = await fakeRegisteredName(page, label, links, () => saved ? { links: { ...links, contact: contactLink("E3") }, nonce: 1 } : { links, nonce: 0 })
  await page.route("**/api/name/records", (route) => {
    saved += 1
    return route.fulfill({ status: 400, json: { error: "bad_request" } })
  })
  await page.goto(`/#/edit/${registrationId}`)
  await previewsShown(page)
  const frames: Record<string, Frame[]> = {}
  await fitsWindow(page, "e1-edit-links", frames)
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("E4"))
  await previewsShown(page)
  await onStep(page).getByRole("button", { name: "Save links" }).click()
  await expect(onStep(page).getByText("An earlier save got there first")).toBeVisible()
  await previewsShown(page)
  await fitsWindow(page, "e2-edit-links-moved", frames)
  oneFrame(frames)
})

// widths a laptop's or a tablet's window has, from where the column first leaves margins beside it
const BACK_WIDTHS = [900, 1024, 1280]

// Back stays inside the window, beside the heading or above it
async function backInView(page: Page, name: string): Promise<void> {
  for (const width of BACK_WIDTHS) {
    await page.setViewportSize({ width, height: FIT_SIZES[0].height })
    const back = onStep(page).locator(".back")
    await expect.poll(async () => {
      const box = (await back.boundingBox())!
      return box.x >= 0 && box.x + box.width <= width
    }, { message: `${name}: Back at ${width} px wide` }).toBe(true)
  }
  await page.setViewportSize(FIT_SIZES[0])
}

// the tops of the home's headline and search
const homeTops = (page: Page) => page.evaluate(() => ["h1", ".search-field"].map((s) => Math.round(document.querySelector(`.home ${s}`)!.getBoundingClientRect().top)))

test("a step's lead breaks where the mockup does on a laptop: in two even lines, or at its line break", async ({ page }) => {
  await search(page, uniqueLabel("lead"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(lineStarts(onStep(page).locator(".lead"))).resolves.toEqual(["P", "o"])
  await page.goto("/#/code")
  await expect(lineStarts(onStep(page).locator(".lead"))).resolves.toEqual(["A", "A"])
})

// the headline's distance under the header, a laptop's and a phone's, as the mockup draws it
const HEADLINE_GAPS = [32, 48]

test("the home keeps its headline and search still as each kind of answer comes, at a laptop's and a phone's size", async ({ page, request }) => {
  for (const [i, size] of FIT_SIZES.entries()) {
    await page.setViewportSize(size)
    await page.goto("/")
    await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
    const before = await homeTops(page)
    const header = Math.round((await page.locator("body > header").boundingBox())!.height)
    expect(before[0] - header, `the headline under the header at ${size.width}x${size.height}`).toBe(HEADLINE_GAPS[i])
    // each search on the same page, whose fonts have loaded: taken, taken without links, reserved, a rule, available, and no answer
    const answers: [string, string, () => Promise<unknown>][] = [["bakery", ".chat", async () => undefined], ["harbour", ".row", async () => undefined],
      ["support", ".line", async () => undefined], ["abc", ".line", async () => undefined], [uniqueLabel("still"), ".price", async () => undefined],
      [uniqueLabel("down"), ".line.warn", () => control(request, "search", { chainDown: true })]]
    for (const [name, answer, before_] of answers) {
      await before_()
      await page.getByLabel("Name", { exact: true }).fill(name)
      await page.getByLabel("Name", { exact: true }).press("Enter")
      await expect(page.locator(`.answer ${answer}`).first()).toBeVisible()
      expect(await homeTops(page), `${name} at ${size.width}x${size.height}: headline and search`).toEqual(before)
      expect(await overflow(page), `${name} at ${size.width}x${size.height}`).toBe(0)
    }
    await control(request, "search", { chainDown: false })
  }
})

const linked = (kind: "contact" | "channel") => ({ type: kind === "contact" ? "address" : "channel", kind, displayName: kind, fullName: "", image: null,
  subscribers: kind === "channel" ? 12 : null, link: kind === "contact" ? contactLink("H1") : channelLink("H2"), deepLink: "simplex:/a#x", profile: "ok" })
// the search's answers for a name: available, taken with two chats, and this browser's, of `owner`, with two chats
const homeAnswers = (owner: string) => ({
  available: { status: "available", price: 10000, currency: "usd", years: 2, termStart: Date.UTC(2027, 0, 1) / 1000, ...CHAIN },
  taken: { status: "registered", entities: [linked("contact"), linked("channel")], owner: `0x${"00".repeat(19)}01`, tld: "simplex" },
  yours: { status: "registered", entities: [linked("contact"), linked("channel")], owner, tld: "simplex" },
})

// how far anything in the answer's row reaches past the row, the row's height and the lines its name takes
const rowFit = (page: Page) => page.evaluate(() => {
  const row = document.querySelector(".answer .row")!.getBoundingClientRect()
  const inside = [...document.querySelectorAll(".answer .row *")].map((n) => n.getBoundingClientRect()).filter((b) => b.height > 0)
  const name = document.querySelector(".answer .row .name")!
  const rest = name.nextElementSibling!.getBoundingClientRect()
  return { spill: Math.round(Math.max(0, ...inside.map((b) => Math.max(b.bottom - row.bottom, row.top - b.top, b.right - row.right, row.left - b.left)))),
    height: Math.round(row.height), nameLines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)),
    ownLine: Math.round(name.getBoundingClientRect().bottom) <= Math.round(rest.top) }
})
// a name of six letters that fits one row beside two chats on a phone, as most do
const SHORT_NAME = "udumhd"

// the service worker of a production build answers these pages before Playwright's routes in WebKit
test.describe(() => {
  test.use({ serviceWorkers: "block" })

  test("each home answer holds its name inside its row, and a name of six letters on one line, at a laptop's and a phone's size", async ({ page }) => {
    for (const label of [SHORT_NAME, wideLabel(6), wideLabel(MAX_LABEL_LENGTH)]) {
      const { owner } = await keepOrder(page, "reg-rowfit", null, label)
      await page.route("**/api/registration/reg-rowfit*", (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
      for (const [state, answer] of Object.entries(homeAnswers(owner))) {
        await page.unroute("**/api/name/**")
        await page.route("**/api/name/**", (route) => route.fulfill({ json: answer }))
        for (const size of FIT_SIZES) {
          await page.setViewportSize(size)
          await page.goto("/#/trademarks")
          await page.goto("/")
          await page.evaluate(() => document.fonts.ready)
          const empty = await homeTops(page)
          await page.getByLabel("Name", { exact: true }).fill(label)
          await page.getByLabel("Name", { exact: true }).press("Enter")
          await expect(page.locator(".answer .row")).toContainText(state === "yours" ? "Your name" : state === "taken" ? "Taken" : "Register")
          const at = `${state}, ${label.length} letters, ${size.width}x${size.height}`
          expect(await homeTops(page), `${at}: headline and search`).toEqual(empty)
          const fit = await rowFit(page)
          expect(fit.spill, `${at}: past its row`).toBe(0)
          if (label.length < 8) expect(fit.nameLines, `${at}: the name's lines`).toBe(1)
          if (label === SHORT_NAME && state !== "available") expect(fit.height, `${at}: the row's height`).toBe(72)
          // a name too long for its row takes a line of its own, its chats and whose it is under it
          if (label.length === MAX_LABEL_LENGTH) expect(fit.ownLine, `${at}: the name's own line`).toBe(state !== "available" || size === FIT_SIZES[1])
          expect(await overflow(page), at).toBe(0)
        }
      }
    }
  })
})

test("the registering page keeps its heading still on a phone from the commit to the name being registered", async ({ page, request }) => {
  await page.setViewportSize(FIT_SIZES[1])
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("regstill")
  await useCode(page, code)
  await search(page, label)
  await toReview(page)
  // each frame's heading top and the words under the clock, while the heading is the registering page's
  await recordFrames(page, () => {
    const heading = document.querySelector("body > main h1")
    const note = document.querySelector(".countdown p")?.firstChild?.textContent ?? ""
    return heading?.textContent!.startsWith("Registering") ? [Math.round(heading.getBoundingClientRect().top), note] : null
  })
  await onStep(page).getByRole("button", { name: "Register with your code" }).click()
  await waitRegistered(page, label)
  const frames = await recordedFrames<[number, string]>(page)
  expect(new Set(frames.map(([, note]) => note)).size, "the page went through more than one stage").toBeGreaterThan(1)
  expect([...new Set(frames.map(([top]) => top))], "the heading's top in each frame").toHaveLength(1)
})

// A name of the widest letters breaks its lines as early as any name of its length can; drawn at random from two
// letters, it is still new to the chain on each run.
const wideLabel = (length: number) => Array.from({ length }, () => (Math.random() < 0.5 ? "m" : "w")).join("")

for (const length of [15, 25, MAX_LABEL_LENGTH]) {
  test(`every purchase step fits both windows for a name of ${length} wide letters`, async ({ page, request }) => {
    const label = wideLabel(length)
    const shots = `long-${length}`
    const frames: Record<string, Frame[]> = {}
    await search(page, label)
    await expect(page.getByRole("button", { name: "Register" })).toBeEnabled()
    await fitsWindow(page, `${shots}-1-home`)
    await page.getByRole("button", { name: "Register" }).click()
    const step = onStep(page)
    await fillLinks(page, contactLink("W1"), channelLink("W2"))
    await previewsShown(page)
    await fitsWindow(page, `${shots}-2-links`, frames)
    await step.getByRole("button", { name: "Continue" }).click()
    await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
    await fitsWindow(page, `${shots}-3-code`, frames)
    await savedToReview(page)
    await fitsWindow(page, `${shots}-4-review`, frames)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
    await fitsWindow(page, `${shots}-5-pay-bitcoin`, frames)
    await control(request, `settle/${new URL(page.url()).searchParams.get("order")}`)
    await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
    await fitsWindow(page, `${shots}-6-registering`)
    await waitRegistered(page, label)
    await fitsWindow(page, `${shots}-7-registered`)
    // a heading with the name in it may take more lines; the main button stays where every step's is
    for (const [i, size] of FIT_SIZES.entries()) {
      expect(new Set(Object.values(frames).map((f) => f[i].actions)).size, `the actions' row at ${size.width}x${size.height}: ${JSON.stringify(frames)}`).toBe(1)
    }
    oneFrame(frames)
  })
}

test("a part paid takes the name's note with its notice, the payment keeping its heading still and fitting both windows", async ({ page, request }) => {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const { invoiceId } = await startOrder(page, uniqueLabel("part"), { method: "btc" })
    await expect(onStep(page).getByText("The name is available")).toBeVisible()
    const before = await headingAt(page)
    await control(request, `partial/${invoiceId}`)
    await expect(onStep(page).locator(".notice.warn", { hasText: "Part of the payment arrived" })).toBeVisible()
    expect(await headingAt(page), `the heading at ${size.width}x${size.height}`).toEqual(before)
    expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    await expect(onStep(page).getByText(/^Part of the payment arrived: [\d.]+ of [\d.]+ BTC is seen\./)).toBeVisible()
    await expect(onStep(page).locator(".name-check")).toHaveCount(0)
  }
  await shot(page, "names-u1-part-paid")
})

test("Check your code keeps its heading and main button still as a verdict comes and goes, at both sizes", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await page.goto("/#/code")
    const at = () => page.evaluate(() => ["body > main h1", "body > main .actions-row .btn"].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().top)))
    const before = await at()
    for (const [typed, verdict] of [["Q", ".verdict.bad"], [code, ".verdict.ok"], ["SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", ".verdict.bad"], ["", ".verdict:empty"]]) {
      await codeField(page).fill(typed)
      await expect(onStep(page).locator(verdict)).toHaveCount(1)
      expect(await at(), `the heading and the button with "${typed}" at ${size.width}x${size.height}`).toEqual(before)
      expect(await overflow(page), `the page's overflow with "${typed}" at ${size.width}x${size.height}`).toBe(0)
    }
  }
})

test("going offline and back moves neither the home's heading nor the review's, and scrolls neither, at both sizes", async ({ page, context }) => {
  const offlineAndBack = async (where: string) => {
    const before = await headingAt(page)
    await context.setOffline(true)
    try {
      await expect(page.locator(".offline-note")).toBeVisible()
      expect(await headingAt(page), `${where}'s heading offline`).toEqual(before)
      expect(await overflow(page), `${where}'s overflow offline`).toBe(0)
    } finally {
      await context.setOffline(false)
    }
    await expect(page.locator(".offline-note")).toBeHidden()
    expect(await headingAt(page), `${where}'s heading back online`).toEqual(before)
    expect(await overflow(page), `${where}'s overflow back online`).toBe(0)
  }
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await page.goto("/")
    await page.evaluate(() => document.fonts.ready)
    await offlineAndBack(`the home at ${size.width}`)
    await toFullReview(page, uniqueLabel("offline"))
    await offlineAndBack(`the review at ${size.width}`)
  }
  await context.setOffline(true)
  await expect(page.locator(".offline-note")).toBeVisible()
  await shot(page, "names-u1-review-offline")
  await context.setOffline(false)
})

test("a line on another order waiting comes into the review below its heading, the review fitting both windows", async ({ page }) => {
  await startOrder(page, uniqueLabel("waiting"), { method: "btc" })
  // the review heading's top in each frame of every page from here on
  await recordFrames(page, () => {
    const heading = document.querySelector("body > main h1")
    return heading?.textContent === "Check your order" ? Math.round(heading.getBoundingClientRect().top) : null
  }, true)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await toFullReview(page, uniqueLabel("other"))
    await expect(onStep(page).getByText("Another order is waiting for its payment.")).toBeVisible()
    await headingAt(page)
    const tops = [...new Set(await recordedFrames<number>(page))]
    expect(tops, `the review heading's tops at ${size.width}x${size.height}`).toHaveLength(1)
    expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    await fitsWindow(page, "4c-review-other-order")
    // its link stays whole on one line, a phone putting the line's words above it
    const link = onStep(page).getByRole("link", { name: "Open that order" })
    expect(await link.evaluate((a) => a.getClientRects().length), `the link's lines at ${size.width}x${size.height}`).toBe(1)
  }
})

// An order of ours found for the name, and a refused link, are each their page's biggest change: the page keeps its
// heading through it and fits both windows.
for (const length of [10, MAX_LABEL_LENGTH]) {
  test(`an order of ours for a name of ${length} wide letters keeps the home still and fitting both windows`, async ({ page }) => {
    const label = wideLabel(length)
    await startOrder(page, label, { method: "btc" })
    for (const size of FIT_SIZES) {
      await page.setViewportSize(size)
      await page.goto("/")
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
      const before = await homeTops(page)
      await page.getByLabel("Name", { exact: true }).fill(label)
      await page.getByLabel("Name", { exact: true }).press("Enter")
      await expect(page.locator(".answer").getByRole("link", { name: "Open that order" })).toBeVisible()
      await expect(page.locator(".answer").getByText("You already have an order for this name")).toBeVisible()
      expect(await homeTops(page), `headline and search at ${size.width}x${size.height}`).toEqual(before)
      expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    }
    await shot(page, `names-u1-home-own-order-${length}`)
  })
}

test(`Edit links keeps still and fits both windows as it saves, for a name of ${MAX_LABEL_LENGTH} wide letters, and Check your code fits them refusing a code`, async ({ page, request }) => {
  const label = wideLabel(MAX_LABEL_LENGTH)
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await page.goto(`/#/edit/${await registrationOf(request, invoiceId)}`)
  const save = page.getByRole("button", { name: "Save links" })
  await expect(save).toBeEnabled()
  await fitsWindow(page, "8-edit-links")
  for (const [i, size] of FIT_SIZES.entries()) {
    await page.setViewportSize(size)
    await page.reload()
    await expect(save).toBeEnabled()
    const before = await headingAt(page)
    // each frame's overflow and heading top, from the change through the save to its answer
    await recordFrames(page, () => [document.scrollingElement!.scrollHeight - innerHeight - Math.round(document.querySelector("body > footer")!.getBoundingClientRect().height),
      Math.round(document.querySelector("main h1")!.getBoundingClientRect().top)])
    const field = page.getByRole("textbox", { name: i ? "Channel" : "Link", exact: true })
    if (i) await page.getByRole("button", { name: "Add a channel link" }).click()
    await field.fill(i ? channelLink(`E${i}`) : contactLink(`E${i}`))
    await field.blur()
    await save.click()
    await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
    expect(await headingAt(page), `the heading once saved at ${size.width}x${size.height}`).toEqual(before)
    const frames = await recordedFrames<[number, number]>(page)
    expect(Math.max(...frames.map(([over]) => over)), `each frame's overflow at ${size.width}x${size.height}`).toBe(0)
    expect([...new Set(frames.map(([, top]) => top))], `the heading's tops at ${size.width}x${size.height}`).toEqual([before.y])
  }
  await shot(page, "names-u1-edit-links-saved")
  await page.goto("/#/code")
  await fitsWindow(page, "9-check-code")
  await codeField(page).fill("SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")
  await expect(onStep(page).getByText("This code is not valid")).toBeVisible()
  await fitsWindow(page, "9b-check-code-refused")
})

test(`a name of ${MAX_LABEL_LENGTH} wide letters in a sentence starts a line of its own, at the sentence's size, its TLD on its last letters' line`, async ({ page }) => {
  await search(page, wideLabel(MAX_LABEL_LENGTH))
  await toCodeStep(page)
  const lead = onStep(page).locator(".lead")
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const drawn = await lead.evaluate((node) => {
      const name = node.querySelector(".nt")!
      const words = document.createRange()
      words.selectNodeContents(node.firstChild!)
      const tail = name.querySelector(".nowrap")!
      return { size: getComputedStyle(name).fontSize === getComputedStyle(node).fontSize, ownLine: Math.round(name.getClientRects()[0].top) > Math.round(words.getClientRects()[0].top),
        tail: tail.textContent, tailLines: new Set([...tail.getClientRects()].map((r) => Math.round(r.top))).size }
    })
    expect(drawn, `the name in the lead at ${size.width}x${size.height}`).toEqual({ size: true, ownLine: true, tail: expect.stringMatching(/^[mw]{3}\.simplex\.$/), tailLines: 1 })
  }
})

test("a refused link reads as a line under its field, and a refused code in a box under its own, at both sizes", async ({ page }) => {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await search(page, uniqueLabel("refusal"))
    const step = onStep(page)
    await step.getByRole("button", { name: "Register" }).click()
    const link = step.getByRole("textbox", { name: "Link", exact: true })
    await link.fill("https://example.com/x#nothing")
    const refusal = step.locator(".field-error")
    await expect(refusal).toHaveText("This is not a SimpleX contact address or channel link.")
    const [drawn, box] = [(await refusal.boundingBox())!, (await step.locator(".link-field .field").boundingBox())!]
    expect({ under: Math.round(drawn.y - box.y - box.height), icon: await refusal.locator("svg").count() }, `the refused link at ${size.width}x${size.height}`).toEqual({ under: 8, icon: 0 })
    await page.goto("/#/code")
    await codeField(page).fill("SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")
    const verdict = onStep(page).locator(".verdict.bad")
    await expect(verdict).toHaveText(/This code is not valid/)
    expect(await verdict.evaluate((v) => getComputedStyle(v).borderTopStyle), `the refused code's box at ${size.width}x${size.height}`).toBe("solid")
  }
})

// The payment's line of name, term and amount: how many separator dots it has, and how many start a line, drawn on
// another line than the character before them.
const separatorsOf = (line: Locator) => line.evaluate((node) => {
  const top = (text: Node, i: number) => { const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1); return Math.round(range.getBoundingClientRect().top) }
  let dots = 0
  let starting = 0
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    for (let i = text.textContent!.indexOf("\u00b7"); i >= 0; i = text.textContent!.indexOf("\u00b7", i + 1)) {
      dots += 1
      if (i === 0 || top(text, i - 1) !== top(text, i)) starting += 1
    }
  }
  return { dots, starting }
})

test("the payment's line keeps its separator dot at the end of a line, never starting one, for long names on a phone", async ({ page }) => {
  await page.setViewportSize(FIT_SIZES[1])
  for (const length of [25, MAX_LABEL_LENGTH]) {
    await startOrder(page, wideLabel(length), { method: "btc" })
    const line = onStep(page).locator(".screen-head .lead")
    await expect(line).toBeVisible()
    const { dots, starting } = await separatorsOf(line)
    expect(dots, `the dots of a name of ${length} letters`).toBe(1)
    expect(starting, `dots starting a line, for a name of ${length} letters`).toBe(0)
  }
})

// the share of its field a focused link's text has, all but the field's icon and padding
const FOCUSED_INPUT_SHARE = 0.7

test("a link field focused shows its link alone, from its start, across the field, at both sizes", async ({ page }) => {
  await search(page, uniqueLabel("focuslink"))
  const step = onStep(page)
  await step.getByRole("button", { name: "Register" }).click()
  await fillLinks(page, contactLink("FL"), channelLink("FL"))
  await previewsShown(page)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    for (const name of ["Link", "Channel"]) {
      const input = step.getByRole("textbox", { name, exact: true })
      const field = step.locator(".link-field .field", { has: page.getByRole("textbox", { name, exact: true }) })
      // a person's click on the profile the field shows
      await field.locator(".entity").click()
      await expect(input).toBeFocused()
      await expect(field.locator(".preview")).toBeHidden()
      const drawn = await input.evaluate((node) => ({ scrolled: node.scrollLeft, share: node.getBoundingClientRect().width / node.closest(".field")!.getBoundingClientRect().width }))
      expect(drawn.scrolled, `${name} at ${size.width}x${size.height}: the link scrolled from its start`).toBe(0)
      expect(drawn.share, `${name} at ${size.width}x${size.height}: the link's share of its field`).toBeGreaterThan(FOCUSED_INPUT_SHARE)
      await input.blur()
      await expect(field.locator(".entity:not(.skeleton)"), `${name}: the profile once the field is left`).toBeVisible()
    }
  }
})

for (const length of [25, MAX_LABEL_LENGTH]) {
  test(`a refused link keeps the links step still and fitting both windows, for a name of ${length} wide letters`, async ({ page }) => {
    for (const size of FIT_SIZES) {
      await page.setViewportSize(size)
      await search(page, wideLabel(length))
      const step = onStep(page)
      await step.getByRole("button", { name: "Register" }).click()
      await step.getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("V3"))
      await step.getByRole("textbox", { name: "Link", exact: true }).blur()
      await expect(step.locator(".link-field .entity:not(.skeleton)")).toBeVisible()
      await step.getByRole("button", { name: "Add a channel link" }).click()
      const before = await headingAt(page)
      await step.getByRole("textbox", { name: "Channel" }).fill(contactLink("V3"))
      await expect(step.locator(".field-error")).toHaveText("This is a contact address. Paste a channel link here.")
      expect(await headingAt(page), `the heading at ${size.width}x${size.height}`).toEqual(before)
      expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
      await fitsWindow(page, `links-refused-${length}`)
    }
  })

  test(`a code shows the review of a free name fitting both windows, for a name of ${length} wide letters`, async ({ page, request }) => {
    const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
    await useCode(page, code)
    await toFullReview(page, wideLabel(length))
    await expect(onStep(page).locator(".trow.total")).toHaveText("Free SimpleX name")
    await expect(onStep(page).getByRole("radio")).toHaveCount(0)
    await fitsWindow(page, `review-code-paid-${length}`)
  })
}
