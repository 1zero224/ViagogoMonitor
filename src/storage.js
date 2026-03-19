const { createClient } = require('@supabase/supabase-js');

const { buildPreviousPricesCache } = require('./normalize');

function createSupabaseClient(config) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey);
}

function normalizeSnapshotRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...(record.snapshot_json || {}),
    linkId: record.link_id ?? record.snapshot_json?.linkId ?? null,
    eventId: record.event_id || record.snapshot_json?.eventId,
    eventUrl: record.event_url || record.snapshot_json?.eventUrl,
    capturedAt: record.captured_at || record.snapshot_json?.capturedAt,
  };
}

async function getLatestPreviousSnapshot(supabase, config, target) {
  let query = supabase
    .from(config.historyTable)
    .select('id, link_id, event_id, event_url, captured_at, snapshot_json')
    .order('captured_at', { ascending: false })
    .limit(1);

  if (target.linkId != null) {
    query = query.eq('link_id', target.linkId);
  } else if (target.eventId) {
    query = query.eq('event_id', target.eventId);
  } else {
    query = query.eq('event_url', target.url);
  }

  const { data, error } = await query;
  if (error) {
    return { snapshot: null, record: null, error };
  }

  const record = data?.[0] || null;
  return {
    snapshot: normalizeSnapshotRecord(record),
    record,
    error: null,
  };
}

async function insertInventorySnapshot(supabase, config, snapshot, target) {
  const payload = {
    link_id: target.linkId ?? null,
    event_id: snapshot.eventId,
    event_url: snapshot.eventUrl,
    captured_at: snapshot.capturedAt,
    snapshot_json: snapshot,
    summary_json: snapshot.summary,
    source: snapshot.source || 'event_page_json',
  };

  const { data, error } = await supabase
    .from(config.historyTable)
    .insert(payload)
    .select('id')
    .limit(1);

  return {
    snapshotId: data?.[0]?.id ?? null,
    error: error || null,
  };
}

async function insertInventoryDiff(supabase, config, diff, snapshotId, previousSnapshotId) {
  const payload = {
    snapshot_id: snapshotId,
    previous_snapshot_id: previousSnapshotId,
    event_id: diff.eventId,
    captured_at: diff.capturedAt,
    change_count: diff.changeCount,
    diff_json: diff,
    alert_sent: false,
  };

  const { data, error } = await supabase
    .from(config.diffTable)
    .insert(payload)
    .select('id')
    .limit(1);

  return {
    diffId: data?.[0]?.id ?? null,
    error: error || null,
  };
}

async function markDiffAlertSent(supabase, config, diffId) {
  if (!diffId) {
    return { error: null };
  }

  const { error } = await supabase
    .from(config.diffTable)
    .update({ alert_sent: true })
    .eq('id', diffId);

  return { error: error || null };
}

async function updateCompatibilityCache(supabase, config, target, snapshot) {
  if (!config.writeCompatibilityCache || target.linkId == null) {
    return { error: null };
  }

  const { error } = await supabase
    .from('vgg_links')
    .update({
      previousprices: buildPreviousPricesCache(snapshot),
      last_checked: snapshot.capturedAt,
    })
    .eq('id', target.linkId);

  return { error: error || null };
}

module.exports = {
  createSupabaseClient,
  getLatestPreviousSnapshot,
  insertInventoryDiff,
  insertInventorySnapshot,
  markDiffAlertSent,
  updateCompatibilityCache,
};
