import { expect, type Locator, type Page } from "@playwright/test"
import { MAX_LABEL_LENGTH } from "../src/names.ts"
import {
  channelLink, checkoutCode, CODE_HEADING, contactLink, control, LINKS_HEADING, onStep, openCode, payButton, previewsShown, recordedFrames, recordFrames, REGISTRATION_MS, registrationOf,
  savedToReview, search, shot, startOrder, test, toFullReview, toReview, uniqueLabel, waitRegistered,
} from "./helpers.ts"

test("the purchase steps swap the whole page, one screen at a time rising in, and Back walks them in reverse", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await search(page, uniqueLabel("swap"))
  const steps: [string, () => Promise<unknown>][] = [
    [LINKS_HEADING, () => page.getByRole("button", { name: "Register" }).click()],
    [CODE_HEADING, () => onStep(page).getByRole("button", { name: "Skip for now" }).click()],
    ["Check your order", () => savedToReview(page)],
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
// how far a step's content may sit off the middle between the header and the footer, or off the room it keeps below it
const CENTRE_PX = 2

// The frame's height for the window, which its observer sets a frame or more after the window changes.
const frameSettled = (page: Page) => page.waitForFunction(() => {
  const parts = [...document.querySelectorAll("body > header, body > footer, body > .offline")]
  const frame = Math.ceil(parts.reduce((h, p) => h + p.getBoundingClientRect().height, 0))
  return getComputedStyle(document.documentElement).getPropertyValue("--frame-h") === `${frame}px`
})

// Where the heading of the screen in view starts, once the frame has its height, a frame after a change, and the
// screen has risen in.
async function headingAt(page: Page): Promise<{ x: number; y: number }> {
  await frameSettled(page)
  return page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))
    const box = document.querySelector("body > main h1")!.getBoundingClientRect()
    return { x: Math.round(box.left), y: Math.round(box.top) }
  })
}

const overflow = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight)

// The screen in view fits the window at each size, its content centred between the header and the footer, or as much
// higher as keeps below it the room its biggest change takes, unless it is the home, which lays itself out as the landing
// does; and is captured for review when shots are asked for. Returns where its heading starts on the laptop's window.
async function fitsWindow(page: Page, name: string, centred = true): Promise<number> {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const measured = () => page.evaluate((bound) => {
      const shown = document.querySelector("body > main > section")!
      const kids = [...shown.children].filter((k) => !k.matches(".vspace") && k.getBoundingClientRect().height > 0)
      const above = kids[0].getBoundingClientRect().top - document.querySelector("body > header")!.getBoundingClientRect().bottom
      const below = document.querySelector("body > footer")!.getBoundingClientRect().top - kids.at(-1)!.getBoundingClientRect().bottom
      // the room the step keeps, resolved by a box out of its flow, and its own padding under its spacer
      const probe = shown.appendChild(document.createElement("div"))
      probe.style.position = "absolute"
      probe.style.height = "max(var(--note-room), var(--room, 0px))"
      const room = probe.getBoundingClientRect().height + parseFloat(getComputedStyle(shown).paddingBottom)
      probe.remove()
      const roomed = above < below && Math.abs(below - room) <= bound
      return { overflow: Math.max(0, document.scrollingElement!.scrollHeight - innerHeight), offCentre: roomed ? 0 : Math.round(Math.abs(above - below)) }
    }, CENTRE_PX)
    // an offset within the bound reads as none, so a failure shows how far off it is
    await expect.poll(async () => {
      const { overflow, offCentre } = await measured()
      return { overflow, offCentre: centred && offCentre > CENTRE_PX ? offCentre : 0 }
    }, { message: `${name} at ${size.width}x${size.height}` }).toEqual({ overflow: 0, offCentre: 0 })
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, `names-g1-${name}`)
  return (await headingAt(page)).x
}

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

test("every purchase step fits a laptop's and a phone's window without scrolling, centred in one column, and keeps still as it fills in", async ({ page, request }) => {
  await page.goto("/")
  await fitsWindow(page, "1-home", false)
  // a taken name with both its links, the tallest answer the home shows
  await search(page, "bakery")
  await expect(page.locator(".answer .entity")).toHaveCount(2)
  await fitsWindow(page, "1b-home-taken", false)
  const label = uniqueLabel("fit")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  const lefts: Record<string, number> = {}
  await expect(step.getByRole("heading", { name: LINKS_HEADING })).toBeFocused()
  await fitsWindow(page, "2a-links-empty")
  const linksAt = await headingAt(page)
  await step.getByLabel("Address").fill(contactLink("F2"))
  await step.getByLabel("Channel").fill(channelLink("G2"))
  await previewsShown(page)
  expect(await headingAt(page), "the links step as its previews come").toEqual(linksAt)
  lefts.links = await fitsWindow(page, "2-links")
  await backInView(page, "links")
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  lefts.code = await fitsWindow(page, "3-code")
  await savedToReview(page)
  lefts.review = await fitsWindow(page, "4-review")
  await backInView(page, "review")
  const reviewAt = await headingAt(page)
  await openCode(page)
  expect(await headingAt(page), "the review as its code field opens").toEqual(reviewAt)
  await fitsWindow(page, "4b-review-code")
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  lefts.payment = await fitsWindow(page, "5-pay-bitcoin")
  const invoiceId = new URL(page.url()).searchParams.get("order")
  await control(request, `confirming/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Confirming your payment" })).toBeVisible()
  lefts.confirming = await fitsWindow(page, "5c-confirming")
  await control(request, `settle/${invoiceId}`)
  await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
  lefts.registering = await fitsWindow(page, "6-registering")
  await waitRegistered(page, label)
  lefts.registered = await fitsWindow(page, "7-registered")
  expect(new Set(Object.values(lefts)).size, `each step's heading starts at the column's edge: ${JSON.stringify(lefts)}`).toBe(1)
  await startOrder(page, uniqueLabel("fitcard"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await fitsWindow(page, "5b-pay-card")
})

// WebKit rounds the home's spacers to whole pixels anew as the content below them changes
const WEBKIT_ROUNDING_PX = 1
// the tops of the home's headline and search
const homeTops = (page: Page) => page.evaluate(() => ["h1", ".search-row"].map((s) => Math.round(document.querySelector(`.home ${s}`)!.getBoundingClientRect().top)))

test("the home keeps its headline and search still as each kind of answer comes, at a laptop's and a phone's size", async ({ page, browserName }) => {
  const rounding = browserName === "webkit" ? WEBKIT_ROUNDING_PX : 0
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await page.goto("/")
    // the frame's height is measured as the page is first laid out, and the fonts change the headline's
    await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))))
    const before = await homeTops(page)
    // each search on the same page, whose fonts have loaded
    for (const [name, answer] of [["bakery", ".entity"], ["harbour", ".note"], ["support", ".line"], ["abc", ".line"], [uniqueLabel("still"), ".price"]]) {
      await page.getByLabel("Name", { exact: true }).fill(name)
      await page.getByLabel("Name", { exact: true }).press("Enter")
      await expect(page.locator(`.answer ${answer}`).first()).toBeVisible()
      const moved = (await homeTops(page)).map((at, i) => Math.abs(at - before[i]))
      expect(Math.max(...moved), `${name} at ${size.width}x${size.height}: headline and search moved ${moved}`).toBeLessThanOrEqual(rounding)
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight), `${name} at ${size.width}x${size.height}`).toBe(size.height)
    }
  }
})

test("the registering page keeps its heading still on a phone from the commit to the name being registered", async ({ page, request }) => {
  await page.setViewportSize(FIT_SIZES[1])
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("regstill")
  await search(page, label)
  await toReview(page)
  await openCode(page)
  await checkoutCode(page).fill(code)
  await expect(onStep(page).getByText("Paid with your code")).toBeVisible()
  // each frame's heading top and the words under the clock, while the heading is the registering page's
  await recordFrames(page, () => {
    const heading = document.querySelector("body > main h1")
    const note = document.querySelector(".countdown p")?.firstChild?.textContent ?? ""
    return heading?.textContent!.startsWith("Registering") ? [Math.round(heading.getBoundingClientRect().top), note] : null
  })
  await onStep(page).getByRole("button", { name: "Register" }).click()
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
    await search(page, label)
    await expect(page.getByRole("button", { name: "Register" })).toBeEnabled()
    await fitsWindow(page, `${shots}-1-home`, false)
    await page.getByRole("button", { name: "Register" }).click()
    const step = onStep(page)
    await step.getByLabel("Address").fill(contactLink("W1"))
    await step.getByLabel("Channel").fill(channelLink("W2"))
    await previewsShown(page)
    await fitsWindow(page, `${shots}-2-links`)
    await step.getByRole("button", { name: "Continue" }).click()
    await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
    await fitsWindow(page, `${shots}-3-code`)
    await savedToReview(page)
    await fitsWindow(page, `${shots}-4-review`)
    await openCode(page)
    await fitsWindow(page, `${shots}-4b-review-code`)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
    await fitsWindow(page, `${shots}-5-pay-bitcoin`)
    await control(request, `settle/${new URL(page.url()).searchParams.get("order")}`)
    await expect(page.locator(".stage.active", { hasText: "Waiting" })).toBeVisible({ timeout: REGISTRATION_MS })
    await fitsWindow(page, `${shots}-6-registering`)
    await waitRegistered(page, label)
    await fitsWindow(page, `${shots}-7-registered`)
  })
}

test("a part paid takes the lead's place with its notice, the payment keeping its heading still and fitting both windows", async ({ page, request }) => {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const { invoiceId } = await startOrder(page, uniqueLabel("part"), { method: "btc" })
    await expect(onStep(page).getByText("Bookmark this page to come back to this payment.")).toBeVisible()
    const before = await headingAt(page)
    await control(request, `partial/${invoiceId}`)
    await expect(onStep(page).locator(".notice.warn", { hasText: "Part of the payment arrived" })).toBeVisible()
    expect(await headingAt(page), `the heading at ${size.width}x${size.height}`).toEqual(before)
    expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    await expect(onStep(page).getByText(/^Part of the payment arrived: [\d.]+ of [\d.]+ BTC is seen\./)).toBeVisible()
    await expect(onStep(page).getByText("Bookmark this page to come back to this payment.")).toHaveCount(0)
  }
  await shot(page, "names-g4-part-paid")
})

test("the review keeps its heading still as a code's verdict comes and goes, with both links, at both sizes", async ({ page }) => {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await toFullReview(page, uniqueLabel("verdict"))
    const before = await headingAt(page)
    await checkoutCode(page).fill("Q")
    await expect(onStep(page).locator(".verdict.bad")).toBeVisible()
    expect(await headingAt(page), `the heading with the verdict at ${size.width}x${size.height}`).toEqual(before)
    expect(await overflow(page), `the page's overflow with the verdict at ${size.width}x${size.height}`).toBe(0)
    await checkoutCode(page).fill("")
    await expect(onStep(page).locator(".verdict.bad")).toHaveCount(0)
    expect(await headingAt(page), `the heading once the verdict clears at ${size.width}x${size.height}`).toEqual(before)
  }
  // a field takes its colour at once for a reader who asked for less movement
  expect(await checkoutCode(page).evaluate((input) => getComputedStyle(input.closest(".field")!).transitionDuration)).toBe("0s")
  await checkoutCode(page).fill("Q")
  await shot(page, "names-g4-review-verdict")
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
  await shot(page, "names-g4-review-offline")
  await context.setOffline(false)
})

test("a line on another order waiting comes into the room the review keeps, the review fitting both windows", async ({ page }) => {
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
    // its link stays whole on one line, a phone putting the line's words above it
    const link = onStep(page).getByRole("link", { name: "Open that order" })
    expect(await link.evaluate((a) => a.getClientRects().length), `the link's lines at ${size.width}x${size.height}`).toBe(1)
  }
  await shot(page, "names-g5-review-other-order")
})

// An order of ours found for the name, a refused link and a code that pays are each their page's biggest change: the
// page keeps its heading through it and fits both windows.
for (const length of [10, MAX_LABEL_LENGTH]) {
  test(`an order of ours for a name of ${length} wide letters keeps the home still and fitting both windows`, async ({ page, browserName }) => {
    const rounding = browserName === "webkit" ? WEBKIT_ROUNDING_PX : 0
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
      const moved = (await homeTops(page)).map((at, i) => Math.abs(at - before[i]))
      expect(Math.max(...moved), `headline and search moved ${moved} at ${size.width}x${size.height}`).toBeLessThanOrEqual(rounding)
      expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    }
    await shot(page, `names-g5-home-own-order-${length}`)
  })
}

test(`Edit links and Restore sit centred as the steps do, and Edit links keeps still and fits both windows as it saves, for a name of ${MAX_LABEL_LENGTH} wide letters`, async ({ page, request }) => {
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
    await recordFrames(page, () => [document.scrollingElement!.scrollHeight - innerHeight, Math.round(document.querySelector("main h1")!.getBoundingClientRect().top)])
    await page.getByRole("textbox", { name: "Channel" }).fill(channelLink(`E${i}`))
    await page.getByRole("textbox", { name: "Channel" }).blur()
    await save.click()
    await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
    expect(await headingAt(page), `the heading once saved at ${size.width}x${size.height}`).toEqual(before)
    const frames = await recordedFrames<[number, number]>(page)
    expect(Math.max(...frames.map(([over]) => over)), `each frame's overflow at ${size.width}x${size.height}`).toBe(0)
    expect([...new Set(frames.map(([, top]) => top))], `the heading's tops at ${size.width}x${size.height}`).toEqual([before.y])
  }
  await shot(page, "names-g7-edit-links-saved")
  await page.goto("/#/restore")
  await fitsWindow(page, "9-restore")
  await page.getByLabel("Name code").fill("SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")
  await page.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByText("This code is not valid")).toBeVisible()
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    expect(await overflow(page), `Restore refused at ${size.width}x${size.height}`).toBe(0)
  }
})

// The payment's line of name, term and amount: how many lines it takes, and how many of its separator dots start a line,
// drawn at the line's left edge.
const separatorsOf = (line: Locator) => line.evaluate((node) => {
  const left = node.getBoundingClientRect().left
  const at = (text: Node, i: number) => { const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1); return range.getBoundingClientRect().left }
  const dots: boolean[] = []
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    for (let i = text.textContent!.indexOf("\u00b7"); i >= 0; i = text.textContent!.indexOf("\u00b7", i + 1)) dots.push(at(text, i) - left < 1)
  }
  return { lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)), dots: dots.length, starting: dots.filter(Boolean).length }
})

test("the payment's line keeps each separator dot at the end of a line, never starting one, for long names on a phone", async ({ page }) => {
  await page.setViewportSize(FIT_SIZES[1])
  for (const length of [25, MAX_LABEL_LENGTH]) {
    await startOrder(page, wideLabel(length), { method: "btc" })
    const line = onStep(page).locator(".lead + .note")
    await expect(line).toBeVisible()
    const { lines, dots, starting } = await separatorsOf(line)
    expect({ wraps: lines > 1, dots }, `the line of a name of ${length} letters`).toEqual({ wraps: true, dots: 2 })
    expect(starting, `dots starting a line, for a name of ${length} letters`).toBe(0)
  }
})

// the share of its field a focused link's text has, all but the field's icon and padding
const FOCUSED_INPUT_SHARE = 0.7

test("a link field focused shows its link alone, from its start, across the field, at both sizes", async ({ page }) => {
  await search(page, uniqueLabel("focuslink"))
  const step = onStep(page)
  await step.getByRole("button", { name: "Register" }).click()
  await step.getByRole("textbox", { name: "Contact address" }).fill(contactLink("FL"))
  await step.getByRole("textbox", { name: "Channel" }).fill(channelLink("FL"))
  await previewsShown(page)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    for (const name of ["Contact address", "Channel"]) {
      const input = step.getByRole("textbox", { name })
      const field = step.locator(".link-field .field", { has: page.getByRole("textbox", { name }) })
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
      await step.getByRole("textbox", { name: "Contact address" }).fill(contactLink("V3"))
      await step.getByRole("textbox", { name: "Contact address" }).blur()
      await expect(step.locator(".link-field .entity:not(.skeleton)")).toBeVisible()
      const before = await headingAt(page)
      await step.getByRole("textbox", { name: "Channel" }).fill(contactLink("V3"))
      await expect(step.locator(".field-error")).toHaveText("This is a contact address link: paste it in the Contact address field.")
      expect(await headingAt(page), `the heading at ${size.width}x${size.height}`).toEqual(before)
      expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    }
    await shot(page, `names-g5-links-refused-${length}`)
  })

  test(`a code that pays keeps the review still and fitting both windows, its verdict only heard, for a name of ${length} wide letters`, async ({ page, request }) => {
    const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
    for (const size of FIT_SIZES) {
      await page.setViewportSize(size)
      await toFullReview(page, wideLabel(length))
      const before = await headingAt(page)
      await checkoutCode(page).fill(code)
      await expect(onStep(page).getByText("Paid with your code")).toBeVisible()
      expect(await headingAt(page), `the heading at ${size.width}x${size.height}`).toEqual(before)
      expect(await overflow(page), `the page's overflow at ${size.width}x${size.height}`).toBe(0)
    }
    // the card says what the verdict says, so the verdict is left for a screen reader to announce
    const verdict = onStep(page).locator(".verdict.ok")
    await expect(verdict).toHaveText(/^Covers names of 6 or more letters/)
    expect(await verdict.evaluate((v) => v.getBoundingClientRect().height), "the verdict's height").toBeLessThanOrEqual(1)
    await shot(page, `names-g5-review-code-paid-${length}`)
  })
}
