# Dispute days: full chain

A local anvil chain with ens-contracts ebf7698 (simplex-mainnet-v2), deployed by the web store's dev/deploy.ts; the store service executable on SQLite, serving the web store's production build; headless Chromium at 1280×800 and 390×844.

- simplex-chat#8317, `ep/names-dispute-days`: b1afe521c9cfc1e5e885d97164668509799a7744; the service was built at 1605c00b7f2df89df460c1677e7254b0534062e2, and b1afe52 changes only scripts/store-service/dev/contract-run.sh
- simplex.domains: #23, `ab/webapp-dispute-days` of brenzi-agent/simplex.domains: ab867bfc07657dbc1fd23c20e894e56ba7e63db4, built as the names site in place of #8317's pin (081069e)
- ens-contracts: ebf76989ec5cab1c7dd49085b4c18faf303657d0, in simplex-namespace-contract e3ba0a50d9475dab8336b5a4026ab0fc5f79ebd4

The page shows no Dispute period row and no dispute end; the service's view still holds `disputeDays` and the registered phase's `disputeUntil`. The order was paid with a prepaid code issued by `--execute "//issue name 6"`; the card review placed no order. Between 04 and 06 the controller's owner (anvil account 0, the deployment's `owner`) called `SimplexController.unregister("disputedemo", 1796641338)` (transaction 0x73ee790c593ac0c1535bda1cf00374fb0da9423ae5b6efe9e2e3d237d217b242, status 1): the registrar's `disputeUntil` and `nameExpires` read 0 after it, and `ownerOf` reverts. Then the service was restarted, and its ended sweep at start logged `names ended sweep: registration cVpdZoSzu4u4X-1yZdfQlA set ended: disputeUntil(id) read at block 125 is 0, not 1796641338`.

| State | Desktop | Phone | Service view |
|---|---|---|---|
| Check your order, disputedemo.simplex with a prepaid code | [01-code-review-desktop.png](01-code-review-desktop.png) | [01-code-review-phone.png](01-code-review-phone.png) | no registration yet |
| The registering page of disputedemo.simplex, waiting after its commit | [01-code-registering-desktop.png](01-code-registering-desktop.png) | [01-code-registering-phone.png](01-code-registering-phone.png) | `phase {"revealAfter":1795431738,"revealBefore":1795518108,"signature":{"type":"signed"},"type":"committed"}`, `disputeDays 14`, `payment {"type":"code"}` |
| The registered order page of disputedemo.simplex | [01-code-registered-desktop.png](01-code-registered-desktop.png) | [01-code-registered-phone.png](01-code-registered-phone.png) | `phase {"disputeUntil":1796641338,"expiresAt":1861833632,"type":"registered"}`, `disputeUntil 1796641338 (2026-12-07T11:02:18Z)`, `disputeDays 14`, `payment {"type":"code"}` |
| Check your order, cardreview.simplex, Card chosen, not paid | [02-card-review-desktop.png](02-card-review-desktop.png) | [02-card-review-phone.png](02-card-review-phone.png) | no registration yet |
| Your names, disputedemo.simplex registered: a registered row shows Until and its date, with no chip | [04-names-registered-desktop.png](04-names-registered-desktop.png) | [04-names-registered-phone.png](04-names-registered-phone.png) | `phase {"disputeUntil":1796641338,"expiresAt":1861833632,"type":"registered"}`, `disputeUntil 1796641338 (2026-12-07T11:02:18Z)`, `disputeDays 14`, `payment {"type":"code"}` |
| The order page of disputedemo.simplex after the service's sweep at start set it ended | [06-order-ended-desktop.png](06-order-ended-desktop.png) | [06-order-ended-phone.png](06-order-ended-phone.png) | `phase {"type":"ended"}`, `disputeDays 14`, `payment {"type":"code"}` |
| Your names, disputedemo.simplex marked Ended | [07-names-ended-desktop.png](07-names-ended-desktop.png) | [07-names-ended-phone.png](07-names-ended-phone.png) | `phase {"type":"ended"}`, `disputeDays 14`, `payment {"type":"code"}` |
| Edit links of disputedemo.simplex once ended | [08-edit-ended-desktop.png](08-edit-ended-desktop.png) | [08-edit-ended-phone.png](08-edit-ended-phone.png) | `phase {"type":"ended"}`, `disputeDays 14`, `payment {"type":"code"}` |
