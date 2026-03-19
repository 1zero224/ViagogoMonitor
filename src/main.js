const { loadConfig, validateRuntimeConfig } = require('./config');
const { diffSnapshots, filterDiffForAlerts } = require('./diff');
const { buildCompatibilitySnapshot } = require('./normalize');
const { initializeFeishuNotifier, sendInventoryNotification } = require('./notify');
const { scrapeEventTarget } = require('./scraper');
const {
  createSupabaseClient,
  getLatestPreviousSnapshot,
  insertInventoryDiff,
  insertInventorySnapshot,
  markDiffAlertSent,
  updateCompatibilityCache,
} = require('./storage');
const { loadTargets } = require('./targets');
const { generateRunId, randomDelay } = require('./utils');

async function processTarget({ target, supabase, feishuWebhookUrl, config, runId }) {
  const scrapeResult = await scrapeEventTarget(target, config, runId);
  if (!scrapeResult.success) {
    return {
      success: false,
      failureType: scrapeResult.failureType,
      reason: scrapeResult.reason,
    };
  }

  const snapshot = scrapeResult.snapshot;
  const previousSnapshotResult = await getLatestPreviousSnapshot(supabase, config, target);
  if (previousSnapshotResult.error) {
    console.warn(`⚠️ Failed to read historical snapshot: ${previousSnapshotResult.error.message}`);
  }

  let previousSnapshot = previousSnapshotResult.snapshot;
  if (!previousSnapshot && target.previousprices && Object.keys(target.previousprices).length > 0) {
    previousSnapshot = buildCompatibilitySnapshot({
      eventUrl: target.url,
      eventId: target.eventId,
      linkId: target.linkId,
      eventDetails: {
        name: snapshot.event.name,
        date: snapshot.event.date,
        location: snapshot.event.location,
        imageUrl: snapshot.event.imageUrl,
      },
      previousPrices: target.previousprices,
      capturedAt: target.last_checked,
    });
    console.log('♻️ Falling back to vgg_links.previousprices as previous snapshot');
  }

  const diff = diffSnapshots(previousSnapshot, snapshot, {
    minTicketDelta: config.minTicketDelta,
  });
  const alertDiff = filterDiffForAlerts(diff, config);

  const snapshotInsert = await insertInventorySnapshot(supabase, config, snapshot, target);
  if (snapshotInsert.error) {
    console.warn(`⚠️ Failed to persist inventory snapshot: ${snapshotInsert.error.message}`);
  } else {
    console.log('✅ Historical snapshot inserted');
  }

  let diffInsert = { diffId: null, error: null };
  if (config.persistDiffs) {
    diffInsert = await insertInventoryDiff(
      supabase,
      config,
      diff,
      snapshotInsert.snapshotId,
      previousSnapshotResult.record?.id ?? null,
    );
    if (diffInsert.error) {
      console.warn(`⚠️ Failed to persist diff document: ${diffInsert.error.message}`);
    } else {
      console.log('✅ Diff document inserted');
    }
  }

  const cacheUpdate = await updateCompatibilityCache(supabase, config, target, snapshot);
  if (cacheUpdate.error) {
    console.warn(`⚠️ Failed to update vgg_links.previousprices cache: ${cacheUpdate.error.message}`);
  } else if (target.linkId != null) {
    console.log('✅ vgg_links.previousprices compatibility cache updated');
  }

  let alertSent = false;
  if (previousSnapshot && alertDiff.changeCount > 0) {
    try {
      alertSent = await sendInventoryNotification(feishuWebhookUrl, {
        snapshot,
        diff: alertDiff,
        config,
      });
      if (alertSent && config.persistDiffs && diffInsert.diffId) {
        const markResult = await markDiffAlertSent(supabase, config, diffInsert.diffId);
        if (markResult.error) {
          console.warn(`⚠️ Failed to mark diff alert_sent=true: ${markResult.error.message}`);
        }
      }
    } catch (error) {
      console.error(`❌ Failed to send Feishu alert: ${error.message}`);
    }
  } else if (!previousSnapshot) {
    console.log('ℹ️ No previous snapshot found, current snapshot stored without alert.');
  } else {
    console.log('ℹ️ Snapshot diff is empty after alert filters, no Feishu alert sent.');
  }

  return {
    success: true,
    snapshot,
    diff,
    alertDiff,
    alertSent,
    snapshotPersisted: !snapshotInsert.error,
  };
}

async function main(argv = []) {
  const config = validateRuntimeConfig(loadConfig(argv));
  const runId = generateRunId();

  console.log('🚀 Viagogo Inventory Monitor starting...');
  console.log(`🆔 Run ID: ${runId}`);
  console.log(`🎯 Mode: ${config.monitorMode}`);
  console.log(`🔐 Supabase credential: ${config.supabaseCredentialSource || 'missing'}`);
  console.log(`🎯 Filters: Artist="${config.artistFilter || 'ALL'}", Country="${config.countryFilter || 'ALL'}"`);
  if (config.eventUrls.length > 0) {
    console.log(`🔗 Direct event mode: ${config.eventUrls.length} URL(s) from CLI/env`);
  }
  console.log('');

  const supabase = createSupabaseClient(config);
  const notifier = await Promise.resolve()
    .then(() => initializeFeishuNotifier(config))
    .catch((error) => {
      console.error(`❌ Feishu notifier initialization failed: ${error.message}`);
      console.warn('⚠️ Continuing without Feishu notifications.');
      return { webhookUrl: null };
    });

  const targets = await loadTargets({ supabase, config });
  if (!targets.length) {
    console.warn('⚠️ No targets found.');
    return 0;
  }

  console.log(`📋 Loaded ${targets.length} target(s)`);
  targets.forEach((target, index) => {
    console.log(`   ${index + 1}. ${target.linkId != null ? `linkId=${target.linkId} | ` : ''}${target.name || target.url}`);
  });

  const totals = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    changeCount: 0,
    alertCount: 0,
  };

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const result = await processTarget({
      target,
      supabase,
      feishuWebhookUrl: notifier.webhookUrl,
      config,
      runId,
    });

    totals.processed += 1;
    if (result.success) {
      totals.succeeded += 1;
      totals.changeCount += result.alertDiff?.changeCount || 0;
      totals.alertCount += result.alertSent ? 1 : 0;
    } else {
      totals.failed += 1;
    }

    if (index < targets.length - 1) {
      await randomDelay(config.betweenTargetDelayMinMs, config.betweenTargetDelayMaxMs);
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('✅ Monitoring cycle completed');
  console.log(`   Targets processed: ${totals.processed}`);
  console.log(`   Succeeded: ${totals.succeeded}`);
  console.log(`   Failed: ${totals.failed}`);
  console.log(`   Alertable changes: ${totals.changeCount}`);
  console.log(`   Feishu alerts sent: ${totals.alertCount}`);
  console.log(`${'='.repeat(72)}\n`);

  return totals.failed > 0 ? 1 : 0;
}

module.exports = {
  main,
};
