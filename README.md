# Viagogo Inventory Monitor

Inventory snapshot monitor for user-specified Viagogo events.

This repository keeps the working real-browser scraping path, but changes the business logic from "price drop only" to a snapshot + diff pipeline that can detect:

- stock appearing after an empty state
- stock selling out
- ticket count increases and decreases
- row additions and removals
- optional price changes

The monitor persists each run to Supabase, keeps `vgg_links.previousprices` as a compatibility cache, and sends grouped Feishu bot alerts.

## Runtime Model

Two target modes are supported:

- direct event mode with `EVENT_URLS` or `node index.js --url "..."`
- database mode by reading targets from `vgg_links`

The main runtime flow is:

1. open the Viagogo event page with `puppeteer-real-browser`
2. intercept the HTML response and parse `<script id="index-data">`
3. normalize inventory rows into a stable snapshot contract
4. load the latest previous snapshot from `vgg_inventory_snapshots`
5. fall back to `vgg_links.previousprices` when historical data is unavailable
6. compute the inventory diff
7. store the new snapshot and update the compatibility cache
8. send grouped Feishu bot alerts for alertable changes

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
BETWEEN_TARGET_DELAY_MIN_MS=10000
BETWEEN_TARGET_DELAY_MAX_MS=20000

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
- if the JSON structure drifts, enable `DUMP_RAW_PAYLOAD_ON_FAILURE=true` to capture the payload for debugging
- the historical snapshot insert can fail independently from the compatibility cache update; the logs call this out explicitly
- Feishu bot alerts are sent only when a previous snapshot exists and the filtered diff is non-empty

## Deployment

The existing Railway/Docker flow still works. The process remains a one-shot runner that is intended to be scheduled by Railway cron or another external scheduler.

For a detailed Chinese deployment and go-live guide, see [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md).

## License

MIT
