// The header's parts that change: the phone's menu, which its button opens over the page, and the tab's active code.
import * as session from "../session.ts"
import { onDrawn, onPageLeft, refresh } from "./shell.ts"

const menuButton = () => document.querySelector<HTMLButtonElement>(".menu-button")!
const menu = () => document.querySelector<HTMLElement>("#menu")!

function setMenu(open: boolean): void {
  menu().hidden = !open
  menuButton().setAttribute("aria-expanded", String(open))
  menuButton().setAttribute("aria-label", open ? "Close menu" : "Menu")
}

function closeMenu(): void {
  if (!menu().hidden) setMenu(false)
}

const chip = () => document.querySelector<HTMLElement>(".code-chip")!

// the active code takes the place of Check your code, with what it pays for
function showCode(): void {
  const code = session.activeCode()
  chip().hidden = code === null
  document.querySelector<HTMLElement>(".check-link")!.hidden = code !== null
  if (code) chip().querySelector(".what")!.textContent = `Code: ${code.minLength}+ letters, ${code.years} years`
}

// a code taken off leaves the checkout it pays for too, unless its order is on its way
function removeCode(): void {
  const code = session.activeCode()
  session.setActiveCode(null)
  const c = session.checkout()
  if (c?.code && c.code.display === code?.display && !session.isSending(c)) session.updateCheckout(c.label, { code: null })
  refresh()
}

export function setUpChrome(): void {
  chip().querySelector("button")!.addEventListener("click", removeCode)
  onDrawn(showCode)
  menuButton().addEventListener("click", () => setMenu(menu().hidden))
  // a link in the menu leaves it closed behind the page it opens, as does any other page reached meanwhile
  menu().addEventListener("click", (e) => { if ((e.target as Element).closest("a")) closeMenu() })
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu().hidden) return
    closeMenu()
    menuButton().focus()
  })
  onPageLeft(closeMenu)
}
