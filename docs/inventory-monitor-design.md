# Inventory Monitor Design

## Goals

The inventory monitor is designed for repeated one-shot runs triggered by an external scheduler.

Core goals:

- normalize every scrape into a stable snapshot contract
- diff consecutive snapshots deterministically
- persist historical snapshots independently from the compatibility cache
- keep Feishu alert formatting out of the scraping path

## Snapshot Contract

Each successful scrape produces a normalized snapshot with:

- `eventId`
- `eventUrl`
- `capturedAt`
- `event`
- `summary`
- `sections`
- `rows`
- `listings`
- `meta`

The important contract decision is that listing-level monitoring now uses a stable listing key:

```text
<listingId>
```

Row aggregates are still kept for summary and compatibility. They remain keyed by:

```text
<ticketClassId>_<sectionId>_<rowId>
```

This lets the diff engine compare individual marketplace listings without depending on display order, while preserving row/section rollups.

`summary` intentionally separates three marketplace layers so logs and alerts do not mix them:

- `rowsWithStock`: normalized row keys with stock
- `totalListingCount`: active marketplace listings
- `totalTicketCount`: aggregate tickets across those listings

## Parser Branches

The scraper currently supports these `index-data` branches:

- `grid.venueMapData`
- `venueMapData`
- `venueMapConfiguration`
- root-level `venueConfiguration`

Row-level inventory resolution now follows this order:

1. `rowPopupData`
2. `sectionPopupData` mapped back through `sourceRowKey`
3. aggregated listing rows from `grid.items`

The parser only emits explicit zero-stock rows when the venue configuration lists a row and none of those sources can resolve inventory for it.

For listing-level monitoring, the scraper also clicks `Show more` until the page reaches `Showing N of N`, and collects the paginated JSON listing batches returned by the event endpoint itself.

The runtime now prefers a stable browser fingerprint by default, narrows listing JSON interception to same-origin XHR/fetch responses for the event path, and keeps per-page response diagnostics so later duplicate or conflicting batches can be inspected from `snapshot.meta`.

## Previous Snapshot Resolution

The runtime resolves the previous snapshot in this order:

1. latest row from `vgg_inventory_snapshots`
2. fallback snapshot rebuilt from `vgg_links.previousprices`

That fallback keeps the migration safe even when the history table is new or temporarily unavailable.

## Diff Taxonomy

The diff engine classifies:

- `stock_appeared`
- `stock_sold_out`
- `ticket_count_increased`
- `ticket_count_decreased`
- `price_decreased`
- `price_increased`
- `new_row_available`
- `row_removed`
- `new_listing_available`
- `listing_removed`
- `listing_ticket_count_increased`
- `listing_ticket_count_decreased`
- `listing_price_decreased`
- `listing_price_increased`

Alert filters are applied after diff generation so the stored diff can remain complete.

Listing availability alerts (`new_listing_available`, `listing_removed`) are additionally debounced against recent snapshot history before notification delivery. The raw diff is still persisted unchanged; only the alert-facing diff is stabilized.

## Persistence Strategy

The implementation writes:

- historical snapshot row to `vgg_inventory_snapshots`
- optional diff row to `vgg_inventory_diffs`
- compatibility cache to `vgg_links.previousprices`
- `vgg_links.last_checked`

The compatibility cache is intentionally not the source of truth anymore. It is only a migration bridge and operational fallback.

## Failure Handling

The scraper classifies failures into:

- `timeout`
- `anti_bot_blocked`
- `json_shape_drift`
- `invalid_event_url`
- `unexpected_error`

When `DUMP_RAW_PAYLOAD_ON_FAILURE=true`, the last intercepted `index-data` payload is written to disk for debugging.

## Testing Strategy

The repository includes:

- parser regression tests using synthetic fixtures
- snapshot normalization tests
- diff classification tests

The tests are intentionally pure and do not require live Viagogo access.
