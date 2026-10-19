import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { mockUrl, pageUrl } from "./slots.ts"

export const SCREENSHOTS = process.env.SCREENSHOTS_DIR ?? "screenshots"
const TAKE_SHOTS = process.env.SHOTS === "1"
const SLOT = Number(process.env.TEST_PARALLEL_INDEX ?? "0")
export const MOCK = process.env.MOCK_URL ?? mockUrl(SLOT)
const DESKTOP = { width: 1280, height: 900 }
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
  // a popup holds the page still, so a person sees the window, which its backdrop covers whole
  const popupOpen = await page.locator(".modal[open]").count() > 0
  // Playwright's WebKit on Linux, drawing in software, takes each capture after a theme switch slower than the last,
  // past a test's time; its captures are a comparison set, so it keeps the light ones
  const themes = browser === "webkit" ? [false] : [false, true]
  for (const [device, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    await page.setViewportSize(size)
    // a phone's scrollbar lies over the page and takes no room
    await page.evaluate((phone) => { document.documentElement.style.scrollbarGutter = phone ? "auto" : "" }, device === "phone")
    for (const dark of themes) {
      await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark)
      await painted()
      await page.screenshot({ path: `${dir}/${name}-${device}-${dark ? "dark" : "light"}.png`, fullPage: !popupOpen, animations: "disabled" })
    }
  }
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark")
    document.documentElement.style.scrollbarGutter = ""
  })
  await page.setViewportSize(DESKTOP)
}

export async function search(page: Page, label: string): Promise<void> {
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
}

export interface OrderOptions {
  method?: "card" | "btc" | "xmr"
  shots?: string
}

const METHOD_NAMES = { card: "Card", btc: "Bitcoin", xmr: "Monero" }

// the purchase step in view; the track keeps the steps beside it, inert, with what they last showed
export const onStep = (page: Page) => page.locator(".slide:not([inert])")
export const payButton = (page: Page) => onStep(page).getByRole("button", { name: /^Pay / })

export const CODE_LABEL = "I have a code"
// checkout's code field, which its "I have a code" link opens
export const checkoutCode = (page: Page) => onStep(page).getByRole("textbox", { name: CODE_LABEL })
export async function openCode(page: Page): Promise<void> {
  await onStep(page).getByRole("button", { name: CODE_LABEL }).click()
  await expect(checkoutCode(page)).toBeFocused()
}

// where session.ts keeps the tab's checkout, with the owner code made for it
const CHECKOUT_KEY = "simplex-names-checkout"
export const checkoutOwnerCode = (page: Page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).ownerCode as string, CHECKOUT_KEY)

// Search and checkout, up to the order's page; returns the invoice and the owner code the browser made for it.
export async function startOrder(page: Page, label: string, opts: OrderOptions = {}): Promise<{ invoiceId: string; ownerCode: string }> {
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
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

export const SAVED = "I have saved my name code"

export const test = base.extend<{}>({
  baseURL: async ({ baseURL }, use) => use(baseURL ?? pageUrl(SLOT)),
})

export async function waitRegistered(page: Page, label: string): Promise<void> {
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
}
