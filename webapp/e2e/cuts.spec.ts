import { expect, type Page } from "@playwright/test"
import { settle, test } from "./helpers.ts"
import { recordCuts, takeCuts } from "./cuts.ts"

test.use({ reducedMotion: "no-preference" })
test.beforeEach(async ({ page }) => { await page.addInitScript(recordCuts) })

const BOX = "position: fixed; left: 100px; top: 300px; width: 240px; height: 60px;"
const PAINT = "background: #fff; border: 1px solid #888;"
const PART_FADE: KeyframeAnimationOptions = { duration: 210, delay: 90, fill: "backwards" }

interface Change { oldPaints: boolean; newPaints: boolean; boxFadeMs: number | null; ownText: boolean }
async function changePage(page: Page, change: Change) {
  await page.goto("/#/trademarks")
  await settle(page)
  await takeCuts(page)
  await page.evaluate(({ change, BOX, PAINT, PART_FADE }) => {
    const box = (paints: boolean, words: string) => {
      const node = document.createElement("div")
      node.setAttribute("style", BOX + (paints ? PAINT : ""))
      if (change.ownText) node.append("Total ")
      const part = document.createElement("span")
      part.textContent = words
      node.append(part)
      return node
    }
    const leaving = document.createElement("div")
    leaving.className = "page-leaving"
    const old = document.createElement("main")
    old.append(box(change.oldPaints, "$100"))
    leaving.append(old)
    document.body.append(leaving)
    const main = document.createElement("main")
    main.style.minHeight = "100px"
    const now = box(change.newPaints, "$0")
    main.append(now)
    document.body.append(main)
    ;(now.lastElementChild as HTMLElement).animate({ opacity: [0, 1] }, PART_FADE)
    if (change.boxFadeMs !== null) now.animate([{ backgroundColor: "transparent", borderColor: "transparent", boxShadow: "none" }, {}], { ...PART_FADE, duration: change.boxFadeMs })
  }, { change, BOX, PAINT, PART_FADE })
  await settle(page)
  return (await takeCuts(page)).filter((c) => c.kind === "cut-in")
}

test("a box standing where the leaving page drew the same box, its new words fading in, is no cut", async ({ page }) => {
  expect(await changePage(page, { oldPaints: true, newPaints: true, boxFadeMs: null, ownText: true })).toEqual([])
})

test("a box standing where the leaving page drew nothing of its own is a cut, though its words are the same", async ({ page }) => {
  expect(await changePage(page, { oldPaints: false, newPaints: true, boxFadeMs: null, ownText: true })).not.toEqual([])
})

test("a new box fading its paint in as long as the page fades in is no cut", async ({ page }) => {
  expect(await changePage(page, { oldPaints: false, newPaints: true, boxFadeMs: 210, ownText: false })).toEqual([])
})

test("a new box fading its paint in too quickly to be seen is a cut", async ({ page }) => {
  expect(await changePage(page, { oldPaints: false, newPaints: true, boxFadeMs: 20, ownText: false })).not.toEqual([])
})

test("a new box with no fade of its paint at all is a cut", async ({ page }) => {
  expect(await changePage(page, { oldPaints: false, newPaints: true, boxFadeMs: null, ownText: false })).not.toEqual([])
})
