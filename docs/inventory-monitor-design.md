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
- `meta`

The important contract decision is that `rows` are keyed by a stable row key:

```text
<ticketClassId>_<sectionId>_<rowId>
```

This lets the diff engine compare rows without depending on display order.

## Parser Branches

The scraper currently supports these `index-data` branches:

- `grid.venueMapData`
- `venueMapData`
- `venueMapConfiguration`
- root-level `venueConfiguration` + `rowPopupData`

The parser emits explicit zero-stock rows when the venue configuration lists a row but `rowPopupData` does not contain inventory for it.

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

Alert filters are applied after diff generation so the stored diff can remain complete.

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
