import { defineConfig, devices } from "@playwright/test"
import { mockUrl, pagePort, pageUrl } from "./e2e/slots.ts"

// BASE_URL points the tests at another server, such as `npx vite preview` of the production build
const BASE_URL = process.env.BASE_URL
// one worker per backend slot, as each slot's chain has one sending key and runs its orders one at a time
const SLOTS = BASE_URL ? 1 : Number(process.env.SLOTS ?? "4")

const CHROME = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] }
const FIREFOX = { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 900 } }
const SAFARI = { ...devices["Desktop Safari"], viewport: { width: 1280, height: 900 } }

// The dev backend (dev/start.sh with as many SLOTS: anvil, contracts, mock) must already run; each worker uses its own.
export default defineConfig({
  testDir: "e2e",
  workers: SLOTS,
  fullyParallel: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: BASE_URL, reducedMotion: "reduce" },
  // Firefox grants clipboard writes from a click without a permission, and has no permission to grant
  projects: [
    { name: "chromium", use: CHROME },
    { name: "firefox", use: FIREFOX },
    { name: "webkit", use: SAFARI },
  ],
  webServer: BASE_URL ? undefined : Array.from({ length: SLOTS }, (_, slot) => ({
    command: `npx vite --host 127.0.0.1 --port ${pagePort(slot)}`,
    url: pageUrl(slot),
    env: { MOCK_URL: mockUrl(slot) },
    reuseExistingServer: true,
  })),
})
