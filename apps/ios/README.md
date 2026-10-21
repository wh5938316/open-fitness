# OpenFitness for iPhone and Apple Watch

Native SwiftUI clients targeting **iOS 26 and watchOS 26**, with Swift 6 strict concurrency and the system Liquid Glass navigation and controls. There are no third-party Swift dependencies. The reusable `OpenFitnessKit` package serves both clients.

## Open and build

Install Xcode 26.0 or newer (Swift 6.2 or newer). The current implementation has been compiled using Xcode 26.5. From the repository root:

```sh
pnpm apple:generate
open apps/ios/OpenFitness.xcodeproj
```

The Python generator produces a deterministic, checked-in Xcode project and shared schemes without XcodeGen. App icons are generated locally by the included AppKit script; generated PNGs are ignored. Regenerate after adding or removing application source files. Swift package source discovery is automatic.

Select the **OpenFitness** scheme for iPhone; the build embeds the **OpenFitnessWatch** companion. Select the watch scheme and a paired Watch destination to run the Watch app. Simulator builds do not need an Apple developer team:

```sh
pnpm apple:test
pnpm apple:lint
pnpm apple:build
xcodebuild -project apps/ios/OpenFitness.xcodeproj -scheme OpenFitness \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath apps/ios/DerivedData CODE_SIGNING_ALLOWED=NO test
```

If `xcode-select` points at Command Line Tools, prefix these commands with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; there is no need to change the global developer directory.

For a physical iPhone and paired Apple Watch, copy `Local.xcconfig.example` to the ignored `Local.xcconfig`, set your development team, and choose unique bundle identifiers if your team requires them. Update the Watch companion identifier and OAuth callback URL scheme together if changing the iOS identifier. Both targets require the HealthKit capability. Sign and run from Xcode. TestFlight/App Store publication and physical device provisioning require your Apple developer account and are separate from simulator validation.

## Connect your service

The default origin is `https://open-fitness.hotee.workers.dev`. The connection screen accepts another HTTPS origin or a pasted `/admin` address. Local development permits HTTP only for `localhost` and `127.0.0.1`.

Tap **Connect with Passkey**, sign in to your service in the system authentication browser, and approve the native OAuth client. The app uses dynamic registration, S256 PKCE, state and issuer validation, and refresh tokens. Credentials and the enrolled HealthKit device secret are kept in Keychain, not settings or source code. A setup token or Cloudflare API token is never an app credential.

The deployed server must include migration `0004_native_health.sql` and the current Worker to enable device enrollment and nutrition export. Earlier server deployments still support training, recipes, and meals; the Health screen explicitly reports the required server update. Existing connections need a fresh owner approval for `health:sync`; enabling nutrition export starts that approval when necessary. Setup is not repeated on an existing installation.

## Implemented flows

- **Today:** daily nutrient totals, active training, plans and quick recipe access. Unknown nutrients remain unknown; the dashboard does not invent calorie targets.
- **Train:** reusable exercise and plan creation, plan instructions, supersets and set types, actual reps/load/time/distance, RPE/RIR, rest timers, completion/cancellation, paginated history, and explicit set corrections. Plans and exercises created by a connected assistant appear through the same API.
- **Food:** unified food search (`search_foods?includeCatalog=true`) plus barcode lookup, explicit `import_food` when a catalog hit is selected, manually described foods with provenance, reusable recipes, batch yield, adjustable servings, one-meal ingredient overrides and additions, ingredient-based meals, time and quantity corrections, deletion, and daily totals. A user-selected recipe photo is downsampled, encoded as JPEG, uploaded privately through Hono/R2, and displayed through authenticated media reads. Bot image recognition and image beautification remain the assistant's responsibility.

Servers from migration `0007_food_catalog` onward own the catalog cache. Older clients that still merge `/api/v1/foods` and `/api/v1/food-catalog` continue to read both endpoints; selecting a catalog product should call `POST /api/v1/foods/import` with the barcode before using it as an ingredient. `search_food_catalog` is deprecated.

- **Health:** user-approved dietary energy, protein, carbohydrates, fat and fiber export, actual receipts, pending delivery display, selected writer controls, pause, and optional short-lived daily HealthKit summary sharing with the coach. OpenFitness never connects directly to Xiaomi services.
- **Watch:** cached plans, exercise navigation, actual set entry, rest countdown, live workout pause/resume/finish, heart rate and active energy through `HKWorkoutSession`, Apple Health workout saving, and durable transfer of structured training commands to the phone.
- **Localization:** English and Simplified Chinese, including permission descriptions, errors and settings; shared API identifiers and user-authored text are unaffected.

The Watch is a companion, not a standalone OAuth client. The iPhone must connect once and transfer a plan. Cached Watch training can continue without reachability; queued operations upload through the paired phone. OAuth and device secrets are never transferred to the Watch. Existing Watch workouts stay bound to their original account when the phone disconnects or changes accounts.

## Retry and privacy behavior

Training commands are saved before transmission and acknowledged only after persistence. The phone resolves offline workout IDs, prepares an exact versioned request, and reuses it after an uncertain response. Explicit version conflicts trigger bounded rebasing; other conflicts remain visible for review. Non-training writes retain their original body and operation ID until the server returns a definite result, including across application restarts. They are recovered on the next refresh. Nutrition changes are calculated by the server before storage.

Caches and queues are account/origin scoped, excluded from backups, and protected until first device unlock. A previously authenticated iPhone can reopen its cached account and plan for up to 24 hours while offline. Pending writes remain durable beyond cache expiry. The app refreshes when foregrounded and requests background refresh; iOS chooses background scheduling, so export is not an immediate delivery guarantee.

Exactly one enrolled iPhone is the nutrition writer. The server leases events for two minutes; the phone applies stable HealthKit sync identifiers and versions and reports success only after HealthKit succeeds. Corrections replace values; missing nutrients remove older samples rather than writing zero. Deletions remove samples created by this app only. Superseded outbox events cannot be acknowledged, and active leases block a writer change. Revocation/recovery disables device credentials. The Watch writes workout samples only; it does not export meals.

Optional coach summaries contain daily steps, active energy, exercise minutes, latest weight and resting heart rate, subject to HealthKit read permission. They expire from the server cache after one hour and are not copied into D1 business records. Disabling sharing stops further uploads; an existing summary expires normally. Raw HealthKit samples remain on the device. Review the included privacy manifests for your deployment and distribution configuration.

## Validation boundaries

`OpenFitnessKit` tests cover PKCE/callback attacks, origin restrictions, concurrent refresh, missing nutrients and health versions, account boundaries, durable retries and both language dictionaries. XCUITest navigates deterministic debug fixtures for training, recipe detail and Chinese settings. Debug fixtures are compiled out of Release. They do not contact a service or claim a real HealthKit write.

Workers integration tests validate the device permission, single writer, leases, receipts, corrections, recovery, and cache boundary against local D1/KV/R2. Browser acceptance validates the shared Clerk sign-in, OAuth, and MCP flow. Production Clerk approval, real Watch sensor data, background delivery, device signing and Apple Health permissions must also be checked on your own physical devices.

Not included: nutrition import mode, multi-device Watch workout mirroring, standalone Watch networking, iPhone-only workout export, Health Connect, long-term imported health aggregates, or App Store submission automation.

References: [Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), [HealthKit sync identifiers](https://developer.apple.com/documentation/healthkit/hkmetadatakeysyncidentifier), and [WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity/wcsession).
