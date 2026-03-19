-- Repeated listing debug queries for Supabase SQL Editor
-- Replace the values inside the params CTE before running.

-- 1) Find listing-level changes that repeat for the same event/listing.
with params as (
  select
    'REPLACE_EVENT_ID'::text as event_id,
    48::int as lookback_hours
),
expanded as (
  select
    d.id as diff_id,
    d.snapshot_id,
    d.previous_snapshot_id,
    d.event_id,
    d.captured_at,
    ch.value as change_json
  from public.vgg_inventory_diffs d
  cross join lateral jsonb_array_elements(d.diff_json -> 'changes') as ch(value)
  join params p on p.event_id = d.event_id
  where d.captured_at >= timezone('utc', now()) - make_interval(hours => (select lookback_hours from params))
    and ch.value ->> 'entityType' = 'listing'
)
select
  event_id,
  change_json ->> 'listingId' as listing_id,
  change_json ->> 'sectionName' as section_name,
  change_json ->> 'rowId' as row_id,
  change_json ->> 'seat' as seat,
  count(*) as hit_count,
  array_agg(change_json ->> 'type' order by captured_at desc) as recent_change_types,
  min(captured_at) as first_seen_at,
  max(captured_at) as last_seen_at
from expanded
group by
  event_id,
  change_json ->> 'listingId',
  change_json ->> 'sectionName',
  change_json ->> 'rowId',
  change_json ->> 'seat'
having count(*) >= 2
order by hit_count desc, last_seen_at desc;

-- 2) Pull one concrete diff row with the exact change JSON and the previous/current listing JSON.
-- Set listing_id to null if you want all listing changes for the event.
with params as (
  select
    'REPLACE_EVENT_ID'::text as event_id,
    null::text as listing_id,
    20::int as row_limit
),
expanded as (
  select
    d.id as diff_id,
    d.snapshot_id,
    d.previous_snapshot_id,
    d.event_id,
    d.captured_at,
    d.change_count,
    d.diff_json,
    ch.value as change_json
  from public.vgg_inventory_diffs d
  cross join lateral jsonb_array_elements(d.diff_json -> 'changes') as ch(value)
  join params p on p.event_id = d.event_id
  where ch.value ->> 'entityType' = 'listing'
)
select
  e.diff_id,
  e.event_id,
  e.captured_at,
  e.change_count,
  e.change_json ->> 'type' as change_type,
  e.change_json ->> 'listingId' as listing_id,
  e.change_json,
  prev.id as previous_snapshot_id,
  prev.captured_at as previous_snapshot_captured_at,
  prev.snapshot_json -> 'listings' -> (e.change_json ->> 'listingId') as previous_listing_json,
  curr.id as current_snapshot_id,
  curr.captured_at as current_snapshot_captured_at,
  curr.snapshot_json -> 'listings' -> (e.change_json ->> 'listingId') as current_listing_json,
  prev.snapshot_json -> 'summary' as previous_summary_json,
  curr.snapshot_json -> 'summary' as current_summary_json
from expanded e
left join public.vgg_inventory_snapshots prev on prev.id = e.previous_snapshot_id
left join public.vgg_inventory_snapshots curr on curr.id = e.snapshot_id
where (
    (select listing_id from params) is null
    or e.change_json ->> 'listingId' = (select listing_id from params)
  )
order by e.captured_at desc, e.diff_id desc
limit (select row_limit from params);

-- 3) Snapshot-only fallback when PERSIST_DIFFS=false.
-- This returns the raw listing JSON across recent snapshots for one event.
-- Set listing_id to null to inspect all listings; otherwise filter to one listing id.
with params as (
  select
    'REPLACE_EVENT_ID'::text as event_id,
    null::text as listing_id,
    12::int as snapshot_limit
),
recent_snapshots as (
  select
    s.id,
    s.event_id,
    s.event_url,
    s.captured_at,
    s.snapshot_json
  from public.vgg_inventory_snapshots s
  join params p on p.event_id = s.event_id
  order by s.captured_at desc
  limit (select snapshot_limit from params)
),
expanded as (
  select
    s.id as snapshot_id,
    s.event_id,
    s.event_url,
    s.captured_at,
    l.key as listing_id,
    l.value as listing_json
  from recent_snapshots s
  cross join lateral jsonb_each(s.snapshot_json -> 'listings') as l(key, value)
)
select
  snapshot_id,
  event_id,
  event_url,
  captured_at,
  listing_id,
  listing_json
from expanded
where (
    (select listing_id from params) is null
    or expanded.listing_id = (select listing_id from params)
  )
order by captured_at desc, listing_id;

-- 4) Snapshot-only transition view for one listing across consecutive runs.
-- This is the most useful query when Feishu repeatedly reports the same listing
-- as added and removed but vgg_inventory_diffs has no rows.
with params as (
  select
    'REPLACE_EVENT_ID'::text as event_id,
    'REPLACE_LISTING_ID'::text as listing_id,
    20::int as snapshot_limit
),
ordered as (
  select
    s.id as snapshot_id,
    s.event_id,
    s.event_url,
    s.captured_at,
    s.snapshot_json,
    lag(s.id) over (partition by s.event_id order by s.captured_at) as previous_snapshot_id,
    lag(s.captured_at) over (partition by s.event_id order by s.captured_at) as previous_captured_at,
    lag(s.snapshot_json) over (partition by s.event_id order by s.captured_at) as previous_snapshot_json
  from public.vgg_inventory_snapshots s
  join params p on p.event_id = s.event_id
),
recent as (
  select *
  from ordered
  order by captured_at desc
  limit (select snapshot_limit from params)
)
select
  previous_snapshot_id,
  previous_captured_at,
  snapshot_id as current_snapshot_id,
  captured_at as current_captured_at,
  case
    when previous_snapshot_json -> 'listings' -> (select listing_id from params) is null
      and snapshot_json -> 'listings' -> (select listing_id from params) is not null
      then 'new_listing_available'
    when previous_snapshot_json -> 'listings' -> (select listing_id from params) is not null
      and snapshot_json -> 'listings' -> (select listing_id from params) is null
      then 'listing_removed'
    when previous_snapshot_json -> 'listings' -> (select listing_id from params) is not null
      and snapshot_json -> 'listings' -> (select listing_id from params) is not null
      then 'present_in_both'
    else 'absent_in_both_or_no_previous'
  end as inferred_transition,
  previous_snapshot_json -> 'listings' -> (select listing_id from params) as previous_listing_json,
  snapshot_json -> 'listings' -> (select listing_id from params) as current_listing_json,
  previous_snapshot_json -> 'summary' as previous_summary_json,
  snapshot_json -> 'summary' as current_summary_json,
  previous_snapshot_json -> 'meta' as previous_meta_json,
  snapshot_json -> 'meta' as current_meta_json
from recent
where
  previous_snapshot_json -> 'listings' -> (select listing_id from params) is not null
  or snapshot_json -> 'listings' -> (select listing_id from params) is not null
order by current_captured_at desc;

-- 5) Check whether the same event is configured multiple times in vgg_links.
with normalized as (
  select
    id,
    url,
    substring(url from '/E-([0-9]+)') as event_id,
    name,
    artist,
    country,
    last_checked
  from public.vgg_links
  where url is not null
)
select
  event_id,
  count(*) as link_count,
  jsonb_agg(
    jsonb_build_object(
      'id', id,
      'url', url,
      'name', name,
      'artist', artist,
      'country', country,
      'last_checked', last_checked
    )
    order by id
  ) as links_json
from normalized
where event_id is not null
group by event_id
having count(*) > 1
order by link_count desc, event_id asc;
