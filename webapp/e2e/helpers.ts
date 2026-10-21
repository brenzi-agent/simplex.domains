import { expect, test as base, type APIRequestContext, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "@playwright/test"
import { mkdirSync, readFileSync } from "node:fs"
import { createPublicClient, http, parseAbi, type Hex } from "viem"
import { labelHash, YEAR_S } from "../src/crypto/registration.ts"
import { checksumAddress, hex } from "../src/crypto/wallet.ts"
import { newOwnerCode, walletOf } from "../src/flow.ts"
import { mockUrl, pageUrl } from "./slots.ts"

const SCREENSHOTS = process.env.SCREENSHOTS_DIR ?? "screenshots"
const TAKE_SHOTS = process.env.SHOTS === "1"
const SLOT = Number(process.env.TEST_PARALLEL_INDEX ?? "0")
export const MOCK = process.env.MOCK_URL ?? mockUrl(SLOT)
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
// commit age plus mining, signing and the register transaction, with room for a slow chain
export const REGISTRATION_MS = 120_000

export function uniqueLabel(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

export const contactLink = (tag: string) => `https://smp8.simplex.im/a#${tag}Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7p`
export const channelLink = (tag: string) => `https://smp9.simplex.im/c#${tag}Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2J`

export async function control(request: APIRequestContext, path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await request.post(`${MOCK}/control/${path}`, { data: body })
  expect(res.ok(), `control ${path}: ${await res.text()}`).toBeTruthy()
  return res.json()
}

export async function registrationOf(request: APIRequestContext, invoiceId: string): Promise<string> {
  const res = await request.get(`${MOCK}/api/invoice/${invoiceId}`)
  return (await res.json()).registration.id
}

interface MockRegistration { invoiceId: string | null; phase: string; revealAfter: number | null; createdAt: string }

export async function mockRegistration(request: APIRequestContext, invoiceId: string): Promise<MockRegistration> {
  const res = await request.get(`${MOCK}/control/state`)
  const { registrations } = await res.json() as { registrations: MockRegistration[] }
  return registrations.find((r) => r.invoiceId === invoiceId)!
}

// The worker's chain, read directly: the expiry the registrar holds and the price the oracle quotes.
const deployment = JSON.parse(readFileSync(new URL(`../dev/local-chain-${SLOT}.json`, import.meta.url), "utf8")) as { rpcUrl: string; controller: Hex; baseRegistrar: Hex }
const chain = createPublicClient({ transport: http(deployment.rpcUrl) })
const CHAIN_ABI = parseAbi([
  "function nameExpires(uint256 id) view returns (uint256)",
  "function rentPriceUSD(string label, uint256 duration) view returns ((uint256 base, uint256 premium))",
])
// SimplexPriceOracle's attoUSD to the cent
const ATTO_PER_CENT = 10n ** 16n

// the time of the block that mined a transaction
export async function blockTimeOf(tx: string): Promise<number> {
  const receipt = await chain.getTransactionReceipt({ hash: tx as Hex })
  return Number((await chain.getBlock({ blockNumber: receipt.blockNumber })).timestamp)
}

export const chainExpiry = async (label: string) =>
  Number(await chain.readContract({ address: deployment.baseRegistrar, abi: CHAIN_ABI, functionName: "nameExpires", args: [BigInt(hex(labelHash(label)))] }))

export async function oracleQuote(label: string, years: number): Promise<number> {
  const quote = await chain.readContract({ address: deployment.controller, abi: CHAIN_ABI, functionName: "rentPriceUSD", args: [label, BigInt(years * YEAR_S)] })
  return Number(quote.base / ATTO_PER_CENT)
}

export async function searchName(request: APIRequestContext, label: string): Promise<Record<string, unknown>> {
  const { labelHash } = await import("../src/crypto/registration.ts")
  const { hex } = await import("../src/crypto/wallet.ts")
  const res = await request.get(`${MOCK}/api/name/${hex(labelHash(label))}?length=${label.length}`)
  return res.json()
}

// The page in light and dark, on a desktop and on a phone; the theme is a class, so no redraw is needed.
export async function shot(page: Page, name: string): Promise<void> {
  if (!TAKE_SHOTS) return
  // Chromium's captures are the reviewed set; other browsers keep theirs beside them, to compare
  const browser = page.context().browser()!.browserType().name()
  const dir = browser === "chromium" ? SCREENSHOTS : `${SCREENSHOTS}/${browser}`
  mkdirSync(dir, { recursive: true })
  // fonts.ready can settle before a face first used on this page has loaded, so every declared face is loaded first
  await page.evaluate(() => Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined))).then(() => document.fonts.ready))
  // a face that just loaded, or a colour just switched, is painted on a later frame
  const painted = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await painted()
  // the pointer is moved off the page's controls, so no capture shows a hover
  await page.mouse.move(0, 0)
  // an open dialog holds the page still, so a person sees the window, which its backdrop covers whole
  const dialogOpen = await page.locator(".modal[open]").count() > 0
  // Playwright's WebKit on Linux, drawing in software, takes each capture after a theme switch slower than the last,
  // past a test's time; its captures are a comparison set, so it keeps the light ones
  const themes = browser === "webkit" ? [false] : [false, true]
  for (const [device, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    await page.setViewportSize(size)
    for (const dark of themes) {
      await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark)
      await painted()
      await page.screenshot({ path: `${dir}/${name}-${device}-${dark ? "dark" : "light"}.png`, fullPage: !dialogOpen, animations: "disabled" })
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await page.setViewportSize(DESKTOP)
}

export async function search(page: Page, label: string): Promise<void> {
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
}

interface OrderOptions {
  method?: "card" | "btc" | "xmr"
  shots?: string
}

const METHOD_NAMES = { card: "Card", btc: "Bitcoin", xmr: "Monero" }

// the screen in view, a purchase step or any other: main holds one at a time
export const onStep = (page: Page) => page.locator("body > main > section")
export const payButton = (page: Page) => onStep(page).getByRole("button", { name: /^Pay / })

// Check your code's field, which takes a prepaid code or a name code
export const codeField = (page: Page) => onStep(page).getByRole("textbox", { name: "Code", exact: true })

// A prepaid code entered in Check your code, which then pays for the names this tab finds.
export async function useCode(page: Page, code: string): Promise<void> {
  await page.goto("/#/code")
  await codeField(page).fill(code)
  await onStep(page).getByRole("button", { name: "Find a name" }).and(page.locator(":enabled")).click()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
}

// A name code entered in Check your code, which finds its order and adds it to Your names.
export async function addNameCode(page: Page, code: string): Promise<void> {
  await page.goto("/#/code")
  await codeField(page).fill(code)
  await onStep(page).getByRole("button", { name: "Add to Your names" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Your names" })).toBeVisible()
}

// A name code added in another browser, whose order, not registered yet, is then opened from its row in Your names.
export async function restoreOrder(page: Page, ownerCode: string, label: string): Promise<void> {
  await addNameCode(page, ownerCode)
  await page.locator(".list-row", { hasText: `${label}.simplex` }).getByRole("button", { name: "Open", exact: true }).click()
}

// the name code on a page, shown first, as a page shows it only on Show
export async function shownCode(page: Page): Promise<Locator> {
  const box = onStep(page).locator(".code-display", { has: page.getByTestId("owner-code") })
  await box.getByRole("button", { name: "Show" }).click()
  return page.getByTestId("owner-code")
}

// where session.ts keeps the tab's checkout, with the owner code made for it
export const CHECKOUT_KEY = "simplex-names-checkout"
export const checkoutOwnerCode = (page: Page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).ownerCode as string, CHECKOUT_KEY)

export const LINKS_HEADING = "What should your name open?"
export const CODE_HEADING = "Save your name code"
export const SAVED = "I have saved my name code"

// An available name's Register, then Skip for now, up to the name code step, which makes the code.
export async function toCodeStep(page: Page): Promise<void> {
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await onStep(page).getByRole("button", { name: "Skip for now" }).click()
  await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
}

// On from the name code step, its box ticked, to Check your order.
export async function savedToReview(page: Page): Promise<void> {
  const box = onStep(page).getByRole("checkbox", { name: SAVED })
  // a code step gone back to keeps its box ticked
  if (!await box.isChecked()) await onStep(page).getByText(SAVED).click()
  await expect(box).toBeChecked()
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
}

// An available name's Register, through the links skipped and the name code saved, to Check your order.
export async function toReview(page: Page): Promise<void> {
  await toCodeStep(page)
  await savedToReview(page)
}

// Each link field's profile, shown once focus has left the field, which shows its link alone while focused.
export async function previewsShown(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (const field of await onStep(page).locator(".link-field").all()) await expect(field.locator(".entity:not(.skeleton)")).toBeVisible()
}

// The Links step's two links: one in its Link field, the other kind in the field its text link adds.
export async function fillLinks(page: Page, contact: string, channel: string): Promise<void> {
  const step = onStep(page)
  await step.getByRole("textbox", { name: "Link", exact: true }).fill(contact)
  await step.getByRole("button", { name: "Add a channel link" }).click()
  await step.getByRole("textbox", { name: "Channel" }).fill(channel)
}

// Search, Register, both links and the name code saved, to Check your order: the review at its fullest.
export async function toFullReview(page: Page, label: string): Promise<void> {
  await search(page, label)
  const step = onStep(page)
  await step.getByRole("button", { name: "Register" }).click()
  await fillLinks(page, contactLink("R1"), channelLink("R2"))
  await previewsShown(page)
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await savedToReview(page)
  // the review's rise ends before it is measured
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))))
}

// Samples every frame from the next one, keeping what `sample` returns other than null; resolves once a frame is sampled.
// With `eachPage`, every page loaded from now on is sampled from its start instead. `sample` runs in the page, by its source.
export async function recordFrames(page: Page, sample: () => unknown, eachPage = false): Promise<void> {
  const recorder = `new Promise((started) => {
    const frames = window.__frames = []
    const sample = ${sample}
    const look = () => {
      const seen = sample()
      if (seen !== null) frames.push(seen)
      started()
      requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  })`
  if (eachPage) await page.addInitScript(recorder)
  else await page.evaluate(recorder)
}

export const recordedFrames = <T>(page: Page) => page.evaluate(() => (window as unknown as { __frames: T[] }).__frames)

// Search and checkout, up to the order's page; returns the invoice and the owner code the browser made for it.
export async function startOrder(page: Page, label: string, opts: OrderOptions = {}): Promise<{ invoiceId: string; ownerCode: string }> {
  await search(page, label)
  await toReview(page)
  await page.getByRole("radio", { name: METHOD_NAMES[opts.method ?? "btc"] }).click()
  const pay = payButton(page)
  await expect(pay).toBeEnabled()
  const ownerCode = await checkoutOwnerCode(page)
  if (opts.shots) await shot(page, `${opts.shots}-checkout`)
  await pay.click()
  await page.waitForURL(/\?order=/)
  // the order's page has replaced the checkout in view, whose Pay a later locator would find otherwise
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toHaveCount(0)
  return { invoiceId: new URL(page.url()).searchParams.get("order")!, ownerCode }
}

const CSP_REPORT = "reportCspViolation"

// Every page's CSP refusals fail its test, in the test's own context and in every context it opens; only a server that
// sends the policy, as `vite preview` does, makes any.
export const test = base.extend<{ cspViolations: void }>({
  baseURL: async ({ baseURL }, use) => use(baseURL ?? pageUrl(SLOT)),
  cspViolations: [async ({ context, browser }, use) => {
    const refused: string[] = []
    const watch = async (watched: BrowserContext) => {
      await watched.exposeBinding(CSP_REPORT, (_source, text: string) => { refused.push(text) })
      await watched.addInitScript((report) => document.addEventListener("securitypolicyviolation", (e) => {
        const send = (window as unknown as Record<string, (text: string) => void>)[report]
        void send(`${e.effectiveDirective} refused ${e.blockedURI || "inline"} ${e.sample}`.trim())
      }, true), CSP_REPORT)
    }
    await watch(context)
    // the browser is the worker's: the maker set on it is deleted after the test, so its class's own shows again
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (options?: BrowserContextOptions) => {
      const made = await newContext(options)
      await watch(made)
      return made
    }
    try {
      await use()
    } finally {
      delete (browser as Partial<Browser>).newContext
    }
    expect(refused, "CSP violations").toEqual([])
  }, { auto: true }],
})

export async function waitRegistered(page: Page, label: string): Promise<void> {
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
}

export const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }

export interface KeptOrder { registrationId: string; invoiceId: string | null; label: string; ownerCode: string; owner: string; request: { labelHash: string; commitment: string } }

// An order of `label` this browser keeps under a name code of its own, as a checkout stores one, with no service behind it.
export async function keepOrder(page: Page, registrationId: string, invoiceId: string | null, label: string, links = { contact: "", channel: "" }): Promise<KeptOrder> {
  const ownerCode = newOwnerCode()
  const owner = checksumAddress(walletOf(ownerCode)!.address)
  const request = { labelHash: hex(labelHash(label)), length: label.length, duration: 2 * YEAR_S, owner, commitment: `0x${"01".repeat(32)}`, sealed: "sealed" }
  const record = { registrationId, invoiceId, label, ownerCode, owner, ...links, method: invoiceId ? "btc" : "code", paid: 10000, years: 2, tld: "simplex",
    createdAt: new Date().toISOString(), request }
  await page.goto("/#/trademarks")
  await page.evaluate((r) => localStorage.setItem(`simplex-names:order:${r.registrationId}`, JSON.stringify(r)), record)
  return record
}

// The service's view of a kept order's registration, as its API answers it.
export const registrationView = (o: KeptOrder, change: Record<string, unknown> = {}) => ({
  ...CHAIN, id: o.registrationId, phase: "unpaid", labelHash: o.request.labelHash, label: o.label, owner: o.owner, commitment: o.request.commitment, sealed: "sealed",
  years: 2, duration: 2 * YEAR_S, price: 10000, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, expiresAt: null, error: null, ...change,
})

// A registered name of this browser's code, as the service answers it, holding `links` until `records` answers otherwise.
export async function fakeRegisteredName(page: Page, label: string, links: { contact: string; channel: string },
  records: () => { links: { contact: string; channel: string }; nonce: number } = () => ({ links, nonce: 0 })): Promise<KeptOrder> {
  const order = await keepOrder(page, `reg-${label.slice(0, 12)}`, null, label, links)
  const expiresAt = Math.floor(Date.now() / 1000) + YEAR_S
  await page.route(`**/api/registration/${order.registrationId}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "registered", commitTx: "0x02", registerTx: "0x03", expiresAt }) }))
  await page.route("**/api/name/**", (route) => {
    const now = records()
    return route.fulfill({ json: { status: "registered", entities: [], owner: order.owner, resolver: CHAIN.resolver, chainId: CHAIN.chainId, records: now.links, recordsNonce: now.nonce,
      expiresAt, tld: "simplex" } })
  })
  return order
}

// The first character of each line a text is drawn in.
export const lineStarts = (text: Locator) => text.evaluate((root) => {
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
