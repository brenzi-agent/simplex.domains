# SimpleX names webapp

The store for SimpleX names on simplex.domains: search a name, pay by card, Bitcoin or Monero (or with a prepaid code), and register it on chain to a wallet made from the buyer's name code. It follows the design in simplex-chat `plans/names-codes/` (spec, sequence diagrams and mockups).

The page talks only to the names service under `/api`. In development that service is `dev/mock.ts`, which drives the real contracts on a local chain and reads names from them directly, as the service does over its Ethereum RPC.

## Layout

- `src/crypto/`: owner and prepaid codes, the wallet, the commitment and the signed messages, the sealed order.
- `src/flow.ts`: building an order, revealing it, another name or a code after `taken`, finding a name code's order, link edits.
- `src/api.ts`, `src/store.ts`, `src/session.ts`: the service's API, what this browser keeps, and the tab's checkout and active prepaid code.
- `src/screens/`: each view's state and the reducer that moves it, with no clock, DOM, storage or network.
- `src/views/`: `shell.ts`, the frame between `index.html`'s header and its invest note and footer (`draw` puts a screen in, `kept` keeps a node a reader types into across redraws, `screen` and `outcome` build the two kinds of screen, `asStep` gives a screen the steps' frame); `chrome.ts`, the phone's menu and the header's active code; and the views: `search.ts` (the home), `checkout.ts` (the Links, name code and Check your order steps), `order.ts` (payment, registration and every ending) and `names.ts` (Your names, Check your code and Edit links). `chats.ts` draws the chats a name opens, as the app's default pictures, and their popup after the app's connection alert; `links.ts` holds the link field that the Links step and Edit links share; `codes.ts` the code field of Check your code.
- `src/stripe.ts`: Stripe's Payment Element, mounted when the page carries a publishable key.
- `src/scan.ts` and `src/views/scan.ts`: a phone's camera reading a link's QR code into the Link field, by the browser's `BarcodeDetector` where it reads QR codes, otherwise by jsQR (Apache-2.0), which is served from the page's own origin and runs only when it first reads a frame; the service worker caches it with the rest of the build, so a page opened before a deploy still reads codes after it. The scan button shows only on a phone with a camera; a camera refused or missing says so, and Paste stays.
- `dev/`: the local chain deployment, the mock service and `start.sh`.
- `test/`: unit tests (vitest). `e2e/`: browser tests (Playwright) against the dev backend.

The window holds the header, the screen and the invest note; the footer is below the fold, as on the badges store. The purchase steps (search, Links, name code, Check your order, payment) follow one another. Each step, and each screen like one (an order's outcome, Check your code, Edit links), is a frame of one height, 572 px on a laptop and 646 px on a phone, the height of the tallest state of any step, so Back, the heading and the main button stand at the same place on every step; the content runs down from under the heading, so nothing above a change moves. The home keeps its answer's room from the start, so its headline and field never move. A prepaid code entered in Check your code pays for the names the tab finds until it is taken off in the header; a name code entered there finds its order and adds it to Your names, or, reached from an order's page, opens the order it found. Every screen replaces the whole page between the header and the invest note and rises into place (220 ms); the old screen goes at once, so two never show together. What a step adds, such as a search's answer, a notice or a link's profile, fades in (180 ms); a change of theme eases its colours (200 ms). A reader who asks for reduced motion gets none of it.

## Run everything with Docker

From this directory, with Docker Compose:

```
docker compose up --build
```

The first build compiles the contracts (a few minutes). Each start deploys them to a fresh local chain, which takes about 2 minutes; the page is then on http://localhost:5173. The mock's controls are on http://localhost:8099/control/… (see below) and the chain's RPC on http://localhost:8545. `docker compose --profile prod up --build preview` serves the production build on http://localhost:4173.

Open the page on `localhost`: the browser gives its crypto API only to a secure context, which plain http on any other address is not.

With the stack up, the tests run from this directory as below, against the published ports.

## Setup

Node 24 runs the dev scripts' TypeScript directly.

```
npm install
npx playwright install chromium firefox webkit
```

The backend needs two things outside this repo:

1. The contracts: ens-contracts at PR #36 (`ab/sponsor-sign-duration`), the submodule of [simplex-namespace-contract](https://github.com/brenzi/simplex-namespace-contract), compiled:

   ```
   git clone https://github.com/brenzi/simplex-namespace-contract.git && cd simplex-namespace-contract
   git submodule update --init ens-contracts && cd ens-contracts
   npx pnpm@9 install --frozen-lockfile --ignore-scripts
   npx hardhat compile
   ```

2. Foundry's `anvil`, from the [release tarball](https://github.com/foundry-rs/foundry/releases). Hardhat's own node does not return revert data, which the mock needs to tell a taken name from a failure.

## Run

```
ENS_CONTRACTS_DIR=<ens-contracts> ANVIL=<anvil> MIN_COMMITMENT_AGE=10 dev/start.sh
npm run dev
```

`start.sh` starts anvil (one block a second), deploys the contracts with `dev/deploy.ts`, registers `bakery` (with links) and `harbour` (without), reserves `support`, `simplex` and `official`, then starts the mock on 127.0.0.1:8099. It prints three prepaid codes. A link's profile, in a name's answer and a link's preview, is the app's: its kind (contact, channel, business or bot), names, picture and a channel's subscribers; the mock makes a contact link whose fragment starts with `Biz` a business, `Bot` a bot, and `Pic` one with a picture. Vite serves the page on http://127.0.0.1:5173 and proxies `/api` and `/control` to the mock.

`MIN_COMMITMENT_AGE` is the seconds a registration waits after its commit; the contracts' deploy scripts use 60.

Without a Stripe key the dev server shows a stand-in card form whose Pay button acts as a submitted card; the production build shows that the card form did not load. The key goes in `index.html`'s `stripe-publishable-key` meta.

### Mock controls

Tests and manual checks move orders along with `POST` requests to the mock:

| Request | Effect |
|---|---|
| `/control/settle/<invoice>` | the invoice is paid; registration starts |
| `/control/partial/<invoice>` | half the crypto amount arrives |
| `/control/confirming/<invoice>` | the full amount is seen, not yet confirmed |
| `/control/expire/<invoice>` | the invoice expires |
| `/control/fail/<registration>` | the next commit fails |
| `/control/take` `{"label"}` | a rival registers the name before the waiting order |
| `/control/search` `{"chainDown", "limitSeconds", "invoiceError", "cancelStillOpen", "findLimitSeconds", "unsentSeconds", "unreadSeconds", "writeDelayMs", "refuseLinks"}` | the chain cannot be read, search is rate limited, the next order is refused (`provider_unavailable`, `rate_limited` with a wait of `MOCK_RETRY_AFTER_SECONDS`, 30 s, `catalog_changed`, `internal`; `null` clears it), the next cancel answers with the invoice still open, finding a code's orders is rate limited, no transaction goes out for that many seconds (each is tried again every `MOCK_RESEND_MS`, 5 s, up to `MOCK_RESENDS`, 12 times), the registration view's own chain reads fail for that many seconds (the view names them in `unread`), every write to a registration waits that long before its version check (to race two requests), or the next reveal finds its links refused |
| `/control/code` `{"minLength", "years", "state"}` | issues a prepaid code |
| `/control/code/state` `{"code", "state"}` | sets a prepaid code's state, as an order elsewhere taking it or letting it go |

`GET /control/state` dumps the mock's registrations and invoices.

## Test

```
npm test          # unit tests
npm run build     # type check and production build into dist/
```

The browser tests run in parallel workers, each with a backend slot of its own: a chain, its deployment and a mock, as orders on one chain go one at a time. Start as many slots as workers, with a short commitment age, quick resends and a short injected rate limit; `start.sh` runs until stopped, so the tests run from another shell:

```
ulimit -c 0
SLOTS=3 MIN_COMMITMENT_AGE=5 MOCK_RESEND_MS=1000 MOCK_RETRY_AFTER_SECONDS=2 ENS_CONTRACTS_DIR=<ens-contracts> ANVIL=<anvil> dev/start.sh
SLOTS=3 npx playwright test
FIREFOX_158=<Firefox 158 executable> SLOTS=3 npx playwright test --project=firefox158
```

`ulimit -c 0`, in each shell, keeps a browser or chain that crashes from leaving a core file. Slot i has its chain on port 8545+i, its deployment in `dev/local-chain-i.json` and its mock on 8099+i; Playwright starts its page server on 5173+i, or uses one already there. `SLOTS` sets the workers too (4 by default); against a single backend, such as Docker Compose's, run with `SLOTS=1`. A slot takes about 1 GB of memory with its browser. A long run grows each chain's memory, so restart `start.sh` between full runs.

`npx playwright test` runs the `chromium`, `firefox` and `webkit` projects in one pool; `--project=chromium` (or `firefox`, `webkit`) runs one browser. Where memory is short, run the three one after another.

The tests run with reduced motion, so screens swap at once, except one test in `e2e/track.spec.ts`, which checks that each purchase step rises in, `e2e/frames.spec.ts`, which samples each frame of the swaps and fails on a near-empty one, and the tests in `e2e/motion.spec.ts` that check the motion itself: that it runs only for a reader who has not asked for less, that a swap never shows two screens at once, that a redraw replays nothing already shown, and that controls follow a switch of theme. `e2e/frames.spec.ts` runs in Chromium and, with `FIREFOX_158`, in Firefox 158: the `firefox158` project runs only this spec and exists only when `FIREFOX_158` names a Firefox 158 or later executable, launched through Playwright's `moz-firefox` channel with its own libraries. While `FIREFOX_158` is set, a plain `npx playwright test` runs `firefox158` too. The `firefox` and `webkit` projects skip it.

With `SHOTS=1` the tests write every screen they reach to `screenshots/` (or `SCREENSHOTS_DIR`), on a desktop and a phone, light and dark; Firefox's and WebKit's go to `screenshots/firefox/` and `screenshots/webkit/`, WebKit's in light only.

The service worker is in the production build only, so `e2e/offline.spec.ts` runs only against it and is skipped otherwise. `vite preview` sends the Content-Security-Policy given under Hosting, from its copy in `vite.config.ts`, and a test fails on any violation a page reports. With slot 0 of the backend up, serve the build, which proxies `/api` to slot 0's mock, and point the tests at it from another shell; they then run in one worker:

```
npm run build && npx vite preview --host 127.0.0.1
BASE_URL=http://127.0.0.1:4173 npx playwright test e2e/offline.spec.ts e2e/track.spec.ts
```

## Hosting

`npm run build` writes a static site to `dist/`. The host it is served from needs:

- `Cache-Control: public, max-age=31536000, immutable` on `/assets/*` (file names carry a content hash), `no-cache` on `index.html` and `/sw.js`, and a day or so on `/fonts/*` and `/img/*`; `no-store` on the service's `/api/*`.
- `/sw.js` served from the site's root, as JavaScript. It is the service worker `sw/plugin.ts` writes into the build: it keeps this build's shell and files in one cache per build, so the page and Your names open offline. The shell is network first, with a 3 s deadline and a check that it names this build's entry module; the build's files are cache first; `/api/*`, other origins and anything else go to the network untouched. The page registers it in the production build only, past the HTTP cache. To take it out, serve a `sw.js` whose install deletes every cache and calls `self.registration.unregister()`.
- Brotli or gzip for HTML, JS, CSS and `favicon.ico`.
- A 404 for unknown paths: the app's routes live in the hash and the query, never in the path.
- Security headers. `e2e/offline.spec.ts`, `e2e/track.spec.ts` and `e2e/paid.spec.ts` run with `BASE_URL` at `vite preview` report no violation in Chromium, Firefox and WebKit, without Stripe.js. Stripe.js loaded with a test key and a mock client secret mounts its frames with no violation in the three; a live Stripe key and 3-D Secure are still to be checked: `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-i5ar+ITNdQiucbmin4/AN6DAY5LbAWeq3at+RiFoUoY=' 'sha256-Jhsw0wf9pI4icAxqab9mIjf34YdecDZeLVN+/KVZW+4=' https://js.stripe.com https://*.js.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (the hashes are index.html's inline theme and font preload scripts, and change with them), `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
- Stripe.js runs on the page's own origin, which keeps the owner codes and prepaid codes in `localStorage`; the CSP admits scripts only from this origin and Stripe's script hosts, and the page loads Stripe.js only on the card screen. The owner accepted this on 2026-10-20, rather than a Checkout redirect or a separate card origin.
- The Stripe publishable key in `index.html`'s `stripe-publishable-key` meta. The service must create each PaymentIntent with `payment_method_types: ["card"]`: the page mounts the Payment Element with Apple Pay, Google Pay and Link off and keeps room for the card form alone, and a form that Stripe cannot load, or that has not loaded after 20 s, leads to the card-not-confirmed page.
- `/manifest.webmanifest` as `application/manifest+json`. With the service worker it makes the site installable as an app; its icons in `img/` are rendered from the SimpleX symbol by `node dev/app-icons.mjs ../img/simplex-symbol-light.svg ../img`.

## Not decided or not built

- The mock is a development fixture, not the service: it keeps everything in memory and moves no money.
