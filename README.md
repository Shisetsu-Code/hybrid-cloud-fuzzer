# Hybrid Cloud Fuzzer

Fast **multi-provider** visual/control classifier for public game demos. It is **not** a game engine, automatic player, gambling bot or real-money casino client. No spins, payments or purchases are performed by this project.

**[Controls from runtime/DOM] → D1 → MCP → decisions**. If the controls are inaccessible or unreliable: **[JPEG → private R2] → MCP vision → normalized marks**. Both paths share the same queue, locks and output contract.

## Provider support

| Provider | Extraction | Fallback |
|---|---|---|
| Pragmatic Play public demos | Read-only runtime controls (Unity/XTButton family) | JPEG for intro/unknown UI |
| HTML-based games of any provider | Visible DOM controls, ARIA, links, toggles | JPEG |
| Playtech, 3Oaks, RubyPlay, Belatra, other canvas providers | Generic DOM where exposed | JPEG until a specific adapter is validated |

This is **provider-agnostic infrastructure**, not a claim that every provider exposes controls in an automatically extractable format. New runtime adapters can be added under `local/adapters/` and registered in `local/extract.js` without changing D1, R2, MCP or the classifier.

## Repository structure

- `src/` — Cloudflare Worker, D1 queue + decisions, R2 images, REST and remote MCP.
- `local/adapters/` — Pragmatic-specific runtime extraction; provider-independent DOM extraction.
- `local/capture.mjs` — Chromium DEMO collector for a multi-provider JSON manifest (max **3 game starts/minute**, persisted across restarts).
- `local/import-fuzzer.mjs` — migrates existing local Fuzzer-Manual captures and runtime metadata without reopening games.
- `local/import-github.mjs` — imports the old **GitHub-only** `catalog-snapshots` branch directly to the hybrid outbox; no manual download of hundreds of images.
- `local/intro.js` / `local/select-frame.js` — safe known Pragmatic intro handling and game-iframe selection, with image fallback when geometry is uncertain.
- `local/sync.mjs` — upload controls as small JSON; upload JPEG **only for visual/hybrid** items.
- `local/export-decisions.mjs` — retrieve classified coordinates for a separate local branch executor.
- `mcp/stdio.mjs` — stdio bridge for Codex/other MCP clients.
- `skills/hybrid-fuzzer/SKILL.md` — short instructions for another assistant chat.

## 1. Deploy Cloudflare (one time)

On Windows PowerShell, Node.js 22+:

```powershell
cd $HOME
git clone https://github.com/Shisetsu-Code/hybrid-cloud-fuzzer.git
cd hybrid-cloud-fuzzer
npm install
npx wrangler login
npx wrangler r2 bucket create hybrid-fuzzer-images
npx wrangler d1 create hybrid-cloud-fuzzer
```

**Copy the D1 `database_id`** returned by the last command into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_UUID`.

```powershell
notepad .\wrangler.toml
npx wrangler d1 migrations apply hybrid-cloud-fuzzer --remote
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put REVIEW_TOKEN
npx wrangler secret put MCP_TOKEN
npx wrangler deploy
```

Generate three **different random secrets** locally (do not post them in chat or commit them):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

For each `wrangler secret put`, paste a different random value. `INGEST_TOKEN` is only for adding images/controls; `REVIEW_TOKEN` is for REST classification; `MCP_TOKEN` is for reading/classifying via MCP. An R2 bucket remains private.

Check the Worker URL printed by Wrangler:

```powershell
curl.exe https://hybrid-cloud-fuzzer.YOUR_ACCOUNT.workers.dev/health
```

`ok:true` requires the D1 binding and schema to be operational. The deployment is **not automatic**: requires your Cloudflare account and these commands.

## 2A. Import existing Fuzzer-Manual screenshots (recommended first)

In one PowerShell session:

```powershell
cd $HOME\hybrid-cloud-fuzzer
node .\local\import-fuzzer.mjs --source="$HOME\Fuzzer-Manual\data\catalog-exports\pragmatic-20261019" --out=outbox --watch
```

In **another** PowerShell session (the ingest token stays in this shell only):

```powershell
cd $HOME\hybrid-cloud-fuzzer
$env:HYBRID_FUZZER_URL = "https://hybrid-cloud-fuzzer.YOUR_ACCOUNT.workers.dev"
$env:HYBRID_INGEST_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'INGEST_TOKEN' -AsSecureString)).Password
node .\local\sync.mjs --out=outbox --watch
```

`--watch` polls for newly captured games. The importer skips the photos already converted locally. For previously classified records in GitHub, the classified JSON **is not migrated automatically**; the image and available control metadata are imported and requeued. For a **GitHub-only** archive, run `node local/import-github.mjs --out=outbox` to fetch the public `Fuzzer-Manual/catalog-snapshots` screenshots directly to outbox. The importer is resumable and does not launch games. Then use the same sync command.

## 2B. Capture new providers locally

Edit `examples/demos.json` with publicly accessible DEMO URLs, using the actual provider ID. Then:

```powershell
node .\local\capture.mjs --manifest=examples/demos.json --out=outbox --rate=3 --limit=5
```

For Pragmatic catalogue URLs the collector rejects catalogue cookies, opens
**Play Demo**, and waits for the game iframe before capturing. If the site asks
for age confirmation, use `--confirm-adult` only after the operator explicitly
confirms they are 18 or older. A missing game iframe fails the capture instead
of uploading the promotional page. Redirects to another page are rejected.

Uses **one shared Chromium process**, one game at a time, never more than 3 new page navigations per minute. It only dismisses a **single verified known Pragmatic INTRO button** (disable with `--no-skip-intro`); never purchases or spins. Unknown provider intro/UI stays on image fallback. Playwright `npx playwright install chromium` is needed the first time. The system can resume from previously generated outbox records. Run the sync command in another shell.

For providers that expose no usable runtime or DOM controls, it still queues a JPEG. Extractor improvement can happen later without changing the user-visible workflow.

## 3. MCP classification — two calls per item

### Windows collector control

On the configured Windows operator PC, the desktop shortcut **Recopilador
Hybrid Fuzzer** opens a panel with **Iniciar**, **Detener** and current status.
Start resumes capture and upload without repeating completed outbox items.
Stop closes both workers and their Chromium processes; completed captures and
upload acknowledgements remain on disk. An interrupted game is retried on resume.
Closing the panel leaves collection running.

The panel uses `scripts/collector-control.ps1`; its worker uses
`.local-state/collector-control.json` and the existing Windows-DPAPI-encrypted
`.wrangler/deployment-secrets.xml`. These machine-specific files stay out of Git.
Command-line control is also available with `-Action Start`, `Stop` or `Status`.
Only verified worker processes from this checkout are controlled.

Configure **remote MCP** at `https://hybrid-cloud-fuzzer.YOUR_ACCOUNT.workers.dev/mcp` with bearer `MCP_TOKEN`. Or, for clients requiring stdio, run `node mcp/stdio.mjs` with `HYBRID_FUZZER_URL` and `HYBRID_MCP_TOKEN` environment variables.

Tools: `next_item`, `save_classification`, **`save_and_next`**, `get_item`, `release_item`, `queue_stats`. For exact commands see [docs/MCP_QUICKSTART.md](docs/MCP_QUICKSTART.md).

1. Call `next_item({runId})`. Structured mode returns **candidate IDs and labels, without image**. Visual/hybrid mode also returns JPEG.
2. Pick all relevant IDs/coordinates and call **`save_and_next`** once with `id`, `leaseId`, `revision`, `sourceSha256` and `runId`: it saves and claims the next item in a single round trip. Alternatively, use `save_classification` then `next_item`.

Example classification for controls:

```json
{
  "id": "run1:pragmatic:game1:base",
  "leaseId": "lease-from-next-item",
  "revision": 1,
  "sourceSha256": "64-hex-hash-from-next-item",
  "status": "classified",
  "reviewer": "gpt",
  "selections": [
    { "candidateId": "c1", "kind": "buy" },
    { "candidateId": "c4", "kind": "navigate" }
  ]
}
```

For visual fallback use normalized marks:

```json
{"marks":[{"x":0.12,"y":0.35,"kind":"buy","label":"Buy Free Spins"}]}
```

The server derives coordinates from selected control rectangles, combines them with manual marks, and stores the result **and its outgoing feed history in one D1 transaction** with lease/revision/hash checks. **No GUI or browser action occurs on the Worker.** An optional read-only feed exists at `GET /v1/decisions?runId=<id>&after=0` using `REVIEW_TOKEN`; export using `local/export-decisions.mjs`. Connecting these decisions to the existing Fuzzer-Manual branch executor requires a separate executor/adapter — this repository does not silently execute selections.

## REST endpoints

| Endpoint | Token | Function |
|---|---|---|
| `GET /health` | none | D1 binding check |
| `POST /v1/items` | INGEST | JSON controls or multipart JPEG + JSON metadata |
| `POST /v1/items/batch` | INGEST | Up to 20 structured control records |
| `POST /v1/claim` | REVIEW | Claim next item (default 180s lease) |
| `POST /v1/save` | REVIEW | Save all selections/marks with CAS |
| `POST /v1/release` | REVIEW | Release lease |
| `GET /v1/stats` | REVIEW | Counters; optional runId/provider |
| `GET /v1/items/:id` | REVIEW | Source/decisions; no public images |
| `GET /v1/items/:id/image` | REVIEW | Private JPEG if present |
| `GET /v1/decisions?after=N` | REVIEW | Valid current classification records |
| `POST /mcp` | MCP | Stateless MCP tools, image only when needed |

Uploads are idempotent for identical item content. To replace a screenshot with the same ID, you must explicitly send `replace=true`. Replacing invalidates all prior marks/leases. Leases expire, preventing concurrent classifiers from corrupting the task. Review images cannot be directly accessed without appropriate tokens.

## Verify locally

```powershell
npm run check
npm test
```

Tests use real SQLite SQL with simulated D1/R2 and cover multi-provider structured/visual classification, private JPEG, transactional leases/history, source replacements, import and re-synchronization. After deployment run `npm run verify:deploy` with `HYBRID_FUZZER_URL`, `HYBRID_MCP_TOKEN` and `HYBRID_REVIEW_TOKEN` set privately. Tests **do not** prove automatic extraction for unknown canvas frameworks or Cloudflare deployment without your account.

## Operational scope

This handles DEMO user interfaces only. Do not supply cookies, credentials, payment sessions or real-money casino URLs. Runtime inspection is read-only. Auto-detection can be inaccurate on obscured controls: if an intro/menu overlay is present, use visual fallback and do not execute a hidden candidate. Any actual click sequence belongs to a separate local DEMO executor after review.

## Codex deployment — no ZIP, patch or manual upload

**This GitHub `main` branch is the authoritative complete source.** To deploy, ask
Codex to clone/pull this repository, run tests and deploy Cloudflare by following
[docs/CODEX_HANDOFF.md](docs/CODEX_HANDOFF.md). Verified scope is in
[docs/VERIFICATION.md](docs/VERIFICATION.md).

The **existing Cloud-Fuzzer MCP remains operational and independent**. Hybrid
Cloud Fuzzer deploys under a different Worker URL with its own D1, R2 and MCP.
Do not remove or replace the legacy MCP before the new MCP passes live checks.
Do not rotate existing secrets without authorization.

## Provider diagnostics (sanitized HAR) and browser speed

The **local** collector can learn network endpoint/action shapes for providers whose
DOM/runtime controls are not accessible. It does **not** automatically synthesize a
trusted adapter from a HAR: network actions alone do not prove which buttons are
visible. An adapter must be validated against a screenshot or runtime controls.

```powershell
cd $HOME\hybrid-cloud-fuzzer
git pull --ff-only
node .\local\capture.mjs --manifest=examples/demos.json --out=outbox --rate=3 --speed=4 --har=fallback
```

- `--har=fallback` (**default**) saves a **sanitized HAR 1.2** under
  `outbox/diagnostics/<run>__<provider>__<game>__<shot>.har` for `visual` or
  `hybrid` captures, unknown states and intros. Failed loads retain a
  `.failed.har` diagnostic if requests were recorded.
- `--har=all` saves a sanitized HAR for every game, including structured ones.
  `--har=off` disables it. HTTP requests/responses and WebSocket frames are
  recorded with bounded limits. Cookie, authorization and token values are
  redacted; large or opaque bodies and JavaScript source are not stored.
- The collector sends only a **small sanitized HAR summary** (endpoints and
  action names) to D1 as `metadata.networkDiagnostics`, available through the
  MCP alongside the image or candidate IDs. The HAR file itself **stays local**
  and is not uploaded to R2 by `local/sync.mjs`.
- To inspect one HAR locally:

```powershell
node .\local\har-report.mjs .\outbox\diagnostics\GAME.har
```

`--speed=1` (default) leaves the browser untouched. `--speed=2`, `4` or `8`
accelerates **game-frame JavaScript timers and requestAnimationFrame time**;
this can shorten some intro/bonus/spin animations. It does **not** accelerate
network requests, server-side game outcomes or the 3-new-games/minute throttle.
It is opt-in because some engines do not tolerate virtual-time changes.
`local/speed.js` exports `installSpeed(frame,factor)` for reuse in a separate
Playwright DEMO branch executor. This collector does not perform spins.

If another local Chromium browser exposes a CDP debugging port, speed can be
changed while that browser is running (only the explicitly selected demo host):

```powershell
node .\local\speed-control.mjs --cdp=http://127.0.0.1:9222 --host=demogamesfree.pragmaticplay.net --speed=4 --watch
```

The CDP port must already be enabled on the browser. This does not start a
browser or make any clicks. Use `--speed=1` to return the timers to normal.
Avoid running it against non-demo tabs or authenticated real-money sessions.

To passively record a **live DEMO spin** in an existing CDP-enabled browser,
without clicking or spinning from this tool:

```powershell
node .\local\speed-control.mjs --cdp=http://127.0.0.1:9222 --host=demogamesfree.pragmaticplay.net --speed=4 --har=outbox/diagnostics/live-demo.har --seconds=90
```

The HAR recorder is scoped to that browser tab and the specified host (including
subdomains). It records only requests made while the command is running, and
saves the sanitized HAR locally. Use a DEMO tab only; do not record accounts.

## 4. Round continuation: reviewed buttons -> branches -> next classifier batch

The **collector** remains read-only; the separate `local/round-runner.mjs` executes **reviewed actions on public DEMO games only**. Cloudflare is the private decision and evidence queue; it does not run a browser or real-money wagers.

The Windows **Recopilador Hybrid Fuzzer** controller now launches a third managed worker named `Branches` alongside `Capture` and `Sync`. The `Branches` worker requires both `INGEST_TOKEN` and `REVIEW_TOKEN` already stored in `.wrangler/deployment-secrets.xml`. A `git pull` alone **does not restart** an existing local worker. Stop and restart it from the controller after updating the code. Existing DPAPI secrets are preserved.

For manual operation in a PowerShell session (the manifest's `runId` must match the Cloudflare classification run):

```powershell
cd $HOME\hybrid-cloud-fuzzer
$env:HYBRID_FUZZER_URL = 'https://hybrid-cloud-fuzzer.braian-n-l.workers.dev'
$env:HYBRID_REVIEW_TOKEN = [Net.NetworkCredential]::new('', (Read-Host 'REVIEW_TOKEN' -AsSecureString)).Password
$env:HYBRID_INGEST_TOKEN = [Net.NetworkCredential]::new('', (Read-Host 'INGEST_TOKEN' -AsSecureString)).Password
node local/round-runner.mjs --manifest=examples/demos.json --out=outbox --watch --limit=5 --interval-ms=15000
```

Each poll waits for `pending=leased=needs_review=0` for **that run**, fetches decisions and current item revisions, and constructs one independent path per selected action. The parent source SHA and revision must still match before use. Every sibling starts in a fresh demo browser context, but all siblings share one Chromium process to avoid repeated launches. A shared cross-process throttle allows at most three new game starts/minute. Unknown or misaligned control geometry is blocked; ordinary BASE Spin, Autoplay and Settings are skipped unless normal demo spins are explicitly permitted with `--allow-normal-spin`. Only controls selected in the reviewed classifications are used to traverse options; no automated visual guessing occurs.

After each action, the child state is saved under a deterministic `step-<hash>` shot ID in the existing outbox and uploaded to `/v1/items`. The action's sanitized HAR is retained locally in `outbox/diagnostics/` and uploaded as a size-bounded, action-correlated private R2 record. D1 stores a hashed index, keyed by source classification and child capture. `GET /v1/traces/<sha256>` requires `REVIEW_TOKEN`; `POST /v1/traces` requires `INGEST_TOKEN`. Existing items and classified decisions are never overwritten. New child records become the next classification batch. A demonstrated `doSpin`/`doBonus` network request marks `metadata.terminal=true` and `evidenceStatus='bet_request_observed'`, **not** `validated`.

The durable `outbox/.round-journal.json` records `running`, `captured`, `done`, `blocked` and `uncertain`. A process crash during a click is *uncertain* and never triggers a silent second wager. A successfully captured but unuploaded branch retries only the idempotent HTTP uploads, not the click. Stale classifications, non-demo URLs and missing controls fail closed. A temporarily empty review queue **does not mean** all games are validated.

### Network-only DEMO replay

The saved sanitized trace records URL, method, action, POST body shape, response status/payload and WebSocket frames. Credentials, cookies, tokens and large/opaque bodies are redacted. For an explicit **HTTP-only** reproduction attempt, first review the command in dry-run mode:

```powershell
node local/replay-demo.mjs --trace=outbox/diagnostics/<record>.har --origin=https://demogamesfree.pragmaticplay.net --contains=doSpin
```

Use `--send` only for a permitted public demo and only after checking the printed request. It sends no credentials, never follows redirects and never retries mutating requests. A redacted session field is a **hard stop** until a fresh, authorized demo session provides the required value. WebSocket provider protocols are not synthetically converted into HTTP, and a captured endpoint alone does not establish a valid replay or simulate complete RNG behaviour. Never point the runner or replayer at real-money casino accounts or payment APIs.

Apply the new `0002_action_traces.sql` migration before deploying the Worker. GitHub `main` is configured for Cloudflare Builds, but a local Git commit or successful Actions job alone is **not** proof of a live Worker deploy. Confirm the production build SHA, `/health`, and the authenticated trace endpoints after merging.
