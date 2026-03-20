# Viagogo Inventory Monitor

Inventory snapshot monitor for user-specified Viagogo events.

This repository keeps the working real-browser scraping path, but changes the business logic from "price drop only" to a snapshot + diff pipeline that can detect:

- new listings appearing
- listings being removed
- listing ticket count increases and decreases
- optional price changes

The runtime keeps page-visible marketplace listings by raw `listingId`, but uses a stable diff key that prefers `aipHash` and falls back to `listingId` to suppress duplicated listing variants and alert jitter, while still keeping row and section rollups for summary and compatibility.

The monitor persists each run to Supabase, keeps `vgg_links.previousprices` as a compatibility cache, and sends grouped Feishu bot alerts.

## Runtime Model

Two target modes are supported:

- direct event mode with `EVENT_URLS` or `node index.js --url "..."`
- database mode by reading targets from `vgg_links`

The main runtime flow is:

1. open the Viagogo event page with `puppeteer-real-browser`
2. intercept the HTML response and parse `<script id="index-data">`
3. load all listing pages by following the event page's `Show more` pagination JSON
4. normalize inventory listings into a stable snapshot contract while preserving row/section rollups
5. load the latest previous snapshot from `vgg_inventory_snapshots`
6. fall back to `vgg_links.previousprices` when historical data is unavailable
7. compute the inventory diff
8. store the new snapshot and update the compatibility cache
9. send grouped Feishu bot alerts for alertable changes

## Project Layout

```text
index.js
src/
  config.js
  diff.js
  main.js
  normalize.js
  notify.js
  scraper.js
  storage.js
  targets.js
docs/
  inventory-monitor-design.md
  supabase-schema.sql
fixtures/
tests/
```

## Required Environment Variables

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

FEISHU_BOT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/your-webhook-token
```

For server-side deployments such as Railway, `SUPABASE_SERVICE_ROLE_KEY` is recommended.
`SUPABASE_ANON_KEY` is still supported as a fallback, but then your tables and policies must explicitly allow the required reads and writes.

## Optional Environment Variables

```env
MONITOR_MODE=inventory
EVENT_URLS=https://www.viagogo.com/.../E-123456789?quantity=2
ARTIST_FILTER=Artist Name
COUNTRY_FILTER=United Kingdom

ALERT_ON_STOCK_APPEAR=true
ALERT_ON_STOCK_DROP=true
ALERT_ON_PRICE_CHANGE=false
MIN_TICKET_DELTA=1
MAX_DIFF_ITEMS_IN_ALERT=10

NAVIGATION_TIMEOUT_MS=80000
JSON_INTERCEPT_TIMEOUT_MS=15000
SECTION_MAP_TIMEOUT_MS=15000
LISTING_PROGRESS_TIMEOUT_MS=12000
LISTING_STABLE_WINDOW_MS=1500
LISTING_FINAL_SETTLE_TIMEOUT_MS=5000
BETWEEN_TARGET_DELAY_MIN_MS=10000
BETWEEN_TARGET_DELAY_MAX_MS=20000

SCRAPER_USER_AGENT=Mozilla/5.0 ...
DEBOUNCE_LISTING_AVAILABILITY_ALERTS=true
LISTING_AVAILABILITY_CONFIRM_RUNS=2

WRITE_PREVIOUSPRICES_CACHE=true
PERSIST_DIFFS=false
DUMP_RAW_PAYLOAD_ON_FAILURE=false
RAW_PAYLOAD_DUMP_DIR=./debug-payloads
```

## Database Schema

Apply [`docs/supabase-schema.sql`](./docs/supabase-schema.sql) before the first production run.

The implementation expects:

- existing `vgg_links` table for target discovery and compatibility cache writes
- `vgg_inventory_snapshots` for historical snapshots
- optional `vgg_inventory_diffs` when `PERSIST_DIFFS=true`

## Usage

Direct URL mode:

```bash
node index.js --url "https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2"
```

Multiple direct URLs:

```bash
EVENT_URLS="https://www.viagogo.com/.../E-111?quantity=2,https://www.viagogo.com/.../E-222?quantity=2" node index.js
```

Database mode:

```bash
node index.js
```

## Tests

Run the parser, snapshot, and diff regression tests:

```bash
npm test
```

Fixtures under [`fixtures/`](./fixtures/) are synthetic contract fixtures for the parser branches. See [`fixtures/README.md`](./fixtures/README.md) for the regeneration runbook.

## Operational Notes

- the scraper still relies on Viagogo's live anti-bot behavior; timeouts and intermittent failures are expected
- listing add/remove alerts are now debounced by recent snapshot history, while raw snapshots and raw diffs still preserve the immediate observation
- snapshot `meta` now stores scraper diagnostics such as `scraperUserAgent`, listing response summaries, replacement/conflict traces, and settle warnings
- if the JSON structure drifts, enable `DUMP_RAW_PAYLOAD_ON_FAILURE=true` to capture the payload for debugging
- the historical snapshot insert can fail independently from the compatibility cache update; the logs call this out explicitly
- Feishu bot alerts are sent only when a previous snapshot exists and the filtered diff is non-empty
- the first deployment after switching from row-level history to listing-level history stores a new listing baseline and intentionally suppresses alerts for that run

## Deployment

The existing Railway/Docker flow still works. The process remains a one-shot runner that is intended to be scheduled by Railway cron or another external scheduler.

For a detailed Chinese deployment and go-live guide, see [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md).

## License

MIT
