import { defineConfig, devices } from "@playwright/test"
import { mockUrl, pagePort, pageUrl } from "./e2e/slots.ts"

// BASE_URL points the tests at another server, such as `npx vite preview` of the production build
const BASE_URL = process.env.BASE_URL
// one worker per backend slot, as each slot's chain has one sending key and runs its orders one at a time
const SLOTS = BASE_URL ? 1 : Number(process.env.SLOTS ?? "4")

const MOTION = /\b(motion|crossing|inplace(-\w+)?|cuts)\.spec\.ts\b|@motion/
const WEBKIT_MOTION_WORKERS = 2
const CHROME = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] }
const FIREFOX = { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 900 } }
const SAFARI = { ...devices["Desktop Safari"], viewport: { width: 1280, height: 900 } }
// At a Mac's scale of 2, WebKit painting in software takes longer over a frame of moving content than a fade lasts; at 1 a frame takes about half as long.
const SAFARI_MOTION = { ...SAFARI, deviceScaleFactor: 1 }
const GENERAL = ["chromium", "firefox", "webkit"]
// A Firefox of 158 or later, as the owner's, draws page changes with view transitions; FIREFOX_158 names its executable.
// It says its own version, which the page reads, rather than the one Playwright's device names; and it finds its own
// libraries, which the library path set for Playwright's own browsers would replace.
const FIREFOX_158 = process.env.FIREFOX_158
const FIREFOX_158_MOTION = FIREFOX_158
  ? [{ name: "firefox158-motion", grep: MOTION, workers: 1, dependencies: GENERAL,
    use: { ...FIREFOX, userAgent: undefined, launchOptions: { channel: "moz-firefox", executablePath: FIREFOX_158, env: { ...process.env, LD_LIBRARY_PATH: "" } } } }]
  : []

// The dev backend (dev/start.sh with as many SLOTS: anvil, contracts, mock) must already run; each worker uses its own.
export default defineConfig({
  testDir: "e2e",
  workers: SLOTS,
  fullyParallel: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  // The page's motion fades content out over what replaces it, which text queries would see twice; the specs check what
  // the page does with the motion off, as a reader who asks for less motion gets it, and motion.spec.ts checks the motion.
  use: { baseURL: BASE_URL, reducedMotion: "reduce" },
  // Firefox grants clipboard writes from a click without a permission, and has no permission to grant
  projects: [
    { name: "chromium", grepInvert: MOTION, use: CHROME },
    { name: "firefox", grepInvert: MOTION, use: FIREFOX },
    { name: "webkit", grepInvert: MOTION, use: SAFARI },
    { name: "chromium-motion", grep: MOTION, workers: 1, dependencies: GENERAL, use: CHROME },
    { name: "firefox-motion", grep: MOTION, workers: 1, dependencies: GENERAL, use: FIREFOX },
    ...FIREFOX_158_MOTION,
    { name: "webkit-motion", grep: MOTION, workers: WEBKIT_MOTION_WORKERS, dependencies: ["chromium-motion", "firefox-motion", ...FIREFOX_158_MOTION.map((p) => p.name)], use: SAFARI_MOTION },
  ],
  webServer: BASE_URL ? undefined : Array.from({ length: SLOTS }, (_, slot) => ({
    command: `npx vite --host 127.0.0.1 --port ${pagePort(slot)}`,
    url: pageUrl(slot),
    env: { MOCK_URL: mockUrl(slot) },
    reuseExistingServer: true,
  })),
})
