import { expect, type Page } from "@playwright/test"
import { control, HANDLE, onStep, shownOrder, startOrder, takenHeading, takenOrder, test, uniqueLabel, waitRegistered } from "./helpers.ts"

const hashQuery = (page: Page) => new URLSearchParams(new URL(page.url()).hash.split("?")[1] ?? "")

test("an order's page and its Edit links are linked by this browser's handle of the order, never by its ids", async ({ page, request }) => {
  const label = uniqueLabel("handle")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  const order = await shownOrder(page)
  expect(order.handle).toMatch(HANDLE)
  expect(new URL(page.url()).search).toBe(`?o=${order.handle}`)
  expect(page.url()).not.toContain(invoiceId)
  expect(page.url()).not.toContain(order.registrationId)
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await onStep(page).getByRole("button", { name: "Add links" }).click()
  await expect(page).toHaveURL(new RegExp(`/#/edit/${order.handle}$`))
})

test("the search for another name from a taken order's page contains the order's handle and none of its ids", async ({ page, request }) => {
  const label = uniqueLabel("handlet")
  const { invoiceId } = await takenOrder(page, request, label)
  const order = await shownOrder(page)
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  expect(hashQuery(page).get("o")).toBe(order.handle)
  expect(page.url()).not.toContain(invoiceId)
  expect(page.url()).not.toContain(order.registrationId)
})

test("an older link of an order by its invoice or registration, and of its Edit links or its search for another name, is replaced by the link of the order's handle", async ({ page, request }) => {
  const label = uniqueLabel("handleo")
  const { invoiceId } = await takenOrder(page, request, label)
  const { handle, registrationId } = await shownOrder(page)
  for (const older of [`/?order=${invoiceId}`, `/?registration=${registrationId}`]) {
    await page.goto(older)
    await expect(page).toHaveURL(new RegExp(`/\\?o=${handle}$`))
    await expect(onStep(page).getByRole("heading", { name: takenHeading(label) })).toBeVisible()
  }
  await page.goto(`/#/edit/${registrationId}`)
  await expect(page).toHaveURL(new RegExp(`/#/edit/${handle}$`))
  await page.goto(`/#/?order=${registrationId}`)
  await expect.poll(() => hashQuery(page).get("o")).toBe(handle)
  expect(hashQuery(page).get("order")).toBeNull()
})

test("in a browser without the order, a handle's link is answered with the line that its name code is not there, and only the config is asked of the service", async ({ page, browser }) => {
  await startOrder(page, uniqueLabel("handlex"), { method: "btc" })
  const { handle } = await shownOrder(page)
  const elsewhere = await (await browser.newContext()).newPage()
  const asked: string[] = []
  elsewhere.on("request", (r) => {
    const { pathname } = new URL(r.url())
    if (pathname.startsWith("/api/") && pathname !== "/api/config") asked.push(pathname)
  })
  await elsewhere.goto(`/?o=${handle}`)
  await expect(onStep(elsewhere).getByRole("heading", { name: "The name code is not in this browser" })).toBeVisible()
  await expect(onStep(elsewhere).getByText("Enter it in Check your code to see this order.")).toBeVisible()
  await expect(onStep(elsewhere).locator(".ref")).toHaveCount(0)
  expect(asked).toEqual([])
})
