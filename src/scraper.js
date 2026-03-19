const fs = require('node:fs/promises');
const path = require('node:path');

const cheerio = require('cheerio');
const { connect } = require('puppeteer-real-browser');

const { buildInventorySnapshot } = require('./normalize');
const {
  buildEventIdFromUrl,
  normalizeWhitespace,
  randomDelay,
  toIsoDate,
  truncate,
} = require('./utils');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const LISTING_PROGRESS_POLL_MS = 500;
const MAX_SHOW_MORE_CLICKS = 20;
const LISTING_OBSERVATION_LIMIT = 25;

function resolveUserAgent(config) {
  return config.scraperUserAgent || DEFAULT_USER_AGENT;
}

function upsertSectionRecord(collection, record) {
  const dedupeKey = record.rowKey || `section:${record.sectionId ?? record.sectionMapName ?? 'unknown'}`;
  const existing = collection.get(dedupeKey);

  if (!existing) {
    collection.set(dedupeKey, record);
    return;
  }

  if (existing.dataNotFound && !record.dataNotFound) {
    collection.set(dedupeKey, record);
    return;
  }

  if (!existing.dataNotFound && record.dataNotFound) {
    return;
  }

  if ((record.ticketCount || 0) > (existing.ticketCount || 0)) {
    collection.set(dedupeKey, record);
  }
}

function buildRowRecord({ sectionId, sectionName, sectionMapName, ticketClassId, rowId, rowPopupEntry }) {
  const rowKey = rowId != null ? `${ticketClassId}_${sectionId}_${rowId}` : null;
  const price = rowPopupEntry?.rawMinPrice ?? null;
  const priceFormatted = rowPopupEntry?.formattedMinPrice ?? null;
  const ticketCount = rowPopupEntry?.ticketCount ?? 0;
  const listingCount = rowPopupEntry?.listingCount ?? rowPopupEntry?.listingsCount ?? 0;

  return {
    sectionName: sectionName || (sectionId != null ? `Section ${sectionId}` : 'Unknown Section'),
    sectionMapName: sectionMapName || sectionName || (sectionId != null ? `Section ${sectionId}` : 'Unknown Section'),
    sectionId,
    rowId,
    ticketClassId,
    rowKey,
    price: price != null ? Number(price) : null,
    priceFormatted,
    ticketCount,
    listingCount,
    rowPopupEntry: rowPopupEntry || null,
    dataNotFound: !rowPopupEntry,
  };
}

function toNullableNumber(value) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCurrencyCode(value) {
  const normalized = normalizeWhitespace(value == null ? null : String(value));
  return normalized ? normalized.toUpperCase() : null;
}

function createFallbackRowPopupEntry() {
  return {
    rawMinPrice: null,
    formattedMinPrice: null,
    ticketCount: null,
    listingCount: null,
    currencyCode: null,
  };
}

function buildSectionPopupFallbackMap(sectionPopupData = {}) {
  const fallback = {};

  for (const entry of Object.values(sectionPopupData || {})) {
    const rowKey = normalizeWhitespace(entry?.sourceRowKey);
    if (!rowKey) {
      continue;
    }

    fallback[rowKey] = {
      rawMinPrice: toNullableNumber(entry.rawMinPrice),
      formattedMinPrice: normalizeWhitespace(entry.formattedMinPrice),
      ticketCount: Math.max(0, toNullableNumber(entry.ticketCount) || 0),
      listingCount: Math.max(0, toNullableNumber(entry.listingCount ?? entry.listingsCount ?? entry.count) || 0),
      currencyCode: normalizeCurrencyCode(entry.currencyCode || entry.currency || entry.buyerCurrencyCode || entry.listingCurrencyCode),
    };
  }

  return fallback;
}

function buildGridItemFallbackMap(gridItems = []) {
  const fallback = {};

  for (const item of gridItems || []) {
    const ticketClassId = item.ticketClass ?? item.ticketClassId ?? null;
    const sectionId = item.sectionId ?? null;
    const rowId = item.rowId ?? null;
    if (ticketClassId == null || sectionId == null || rowId == null) {
      continue;
    }

    const rowKey = `${ticketClassId}_${sectionId}_${rowId}`;
    const existing = fallback[rowKey] || createFallbackRowPopupEntry();
    const availableTickets = Math.max(0, toNullableNumber(item.availableTickets ?? item.ticketCount) || 0);
    const rawPrice = toNullableNumber(item.rawPrice ?? item.rawMinPrice ?? item.priceValue);
    const formattedPrice =
      normalizeWhitespace(item.formattedMinPrice) ||
      normalizeWhitespace(item.formattedPrice) ||
      normalizeWhitespace(item.price) ||
      null;
    const currencyCode = normalizeCurrencyCode(item.buyerCurrencyCode || item.currencyCode || item.listingCurrencyCode);

    existing.ticketCount = (existing.ticketCount || 0) + availableTickets;
    existing.listingCount = (existing.listingCount || 0) + 1;

    if (rawPrice != null && (existing.rawMinPrice == null || rawPrice < existing.rawMinPrice)) {
      existing.rawMinPrice = rawPrice;
      existing.formattedMinPrice = formattedPrice || existing.formattedMinPrice;
    } else if (!existing.formattedMinPrice && formattedPrice) {
      existing.formattedMinPrice = formattedPrice;
    }

    if (!existing.currencyCode && currencyCode) {
      existing.currencyCode = currencyCode;
    }

    fallback[rowKey] = existing;
  }

  return fallback;
}

function buildFallbackRowPopupData(sectionPopupData = {}, gridItems = []) {
  const sectionFallback = buildSectionPopupFallbackMap(sectionPopupData);
  const gridFallback = buildGridItemFallbackMap(gridItems);
  const merged = { ...gridFallback };

  for (const [rowKey, sectionEntry] of Object.entries(sectionFallback)) {
    const gridEntry = gridFallback[rowKey] || {};
    merged[rowKey] = {
      rawMinPrice: sectionEntry.rawMinPrice ?? gridEntry.rawMinPrice ?? null,
      formattedMinPrice: sectionEntry.formattedMinPrice ?? gridEntry.formattedMinPrice ?? null,
      ticketCount: sectionEntry.ticketCount ?? gridEntry.ticketCount ?? 0,
      listingCount: sectionEntry.listingCount ?? gridEntry.listingCount ?? 0,
      currencyCode: sectionEntry.currencyCode ?? gridEntry.currencyCode ?? null,
    };
  }

  return merged;
}

function getVenueMapSource(jsonData) {
  if (jsonData.grid?.venueMapData?.venueConfiguration) {
    return {
      label: 'grid.venueMapData',
      venueConfiguration: jsonData.grid.venueMapData.venueConfiguration,
      rowPopupData: jsonData.grid.venueMapData.rowPopupData || {},
      sectionPopupData: jsonData.grid.venueMapData.sectionPopupData || {},
      gridItems: jsonData.grid.items || [],
    };
  }

  if (jsonData.venueMapData?.venueConfiguration) {
    return {
      label: 'venueMapData',
      venueConfiguration: jsonData.venueMapData.venueConfiguration,
      rowPopupData: jsonData.venueMapData.rowPopupData || {},
      sectionPopupData: jsonData.venueMapData.sectionPopupData || {},
      gridItems: jsonData.grid?.items || [],
    };
  }

  if (jsonData.venueMapConfiguration?.venueConfiguration) {
    return {
      label: 'venueMapConfiguration',
      venueConfiguration: jsonData.venueMapConfiguration.venueConfiguration,
      rowPopupData: jsonData.venueMapConfiguration.rowPopupData || {},
      sectionPopupData: jsonData.venueMapConfiguration.sectionPopupData || {},
      gridItems: jsonData.grid?.items || [],
    };
  }

  if (jsonData.venueConfiguration) {
    return {
      label: 'root',
      venueConfiguration: jsonData.venueConfiguration,
      rowPopupData: jsonData.rowPopupData || {},
      sectionPopupData: jsonData.sectionPopupData || {},
      gridItems: jsonData.grid?.items || [],
    };
  }

  return null;
}

function getEventRequestPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, '');
  } catch (error) {
    return String(url || '').split('?')[0].replace(/https?:\/\/[^/]+/i, '').replace(/\/+$/, '');
  }
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (error) {
    return null;
  }
}

function selectQuerySummary(parsedUrl) {
  if (!parsedUrl) {
    return {};
  }

  const keys = ['currentPage', 'page', 'pageNumber', 'p', 'quantity', 'qty', 'currency', 'sort'];
  const summary = {};
  for (const key of keys) {
    const value = parsedUrl.searchParams.get(key);
    if (value != null && value !== '') {
      summary[key] = value;
    }
  }

  return summary;
}

function resolveQuantity(parsedUrl) {
  if (!parsedUrl) {
    return null;
  }

  return parsedUrl.searchParams.get('quantity') || parsedUrl.searchParams.get('qty') || null;
}

function isEventListingJsonResponse(responseUrl, targetUrl, contentType, resourceType) {
  if (!/application\/json/i.test(contentType || '')) {
    return false;
  }

  if (!['fetch', 'xhr'].includes(resourceType)) {
    return false;
  }

  const parsedResponseUrl = parseUrl(responseUrl);
  const parsedTargetUrl = parseUrl(targetUrl);
  if (!parsedResponseUrl || !parsedTargetUrl) {
    return getEventRequestPath(responseUrl) === getEventRequestPath(targetUrl);
  }

  if (parsedResponseUrl.origin !== parsedTargetUrl.origin) {
    return false;
  }

  if (parsedResponseUrl.pathname.replace(/\/+$/, '') !== parsedTargetUrl.pathname.replace(/\/+$/, '')) {
    return false;
  }

  const targetQuantity = resolveQuantity(parsedTargetUrl);
  const responseQuantity = resolveQuantity(parsedResponseUrl);
  if (targetQuantity && responseQuantity && targetQuantity !== responseQuantity) {
    return false;
  }

  return true;
}

function extractListingItemsFromPayload(payload) {
  if (!payload || !Array.isArray(payload.items)) {
    return [];
  }

  return payload.items.filter((item) => item && (item.id != null || item.listingId != null));
}

function dedupeListingItems(items = []) {
  const deduped = new Map();

  for (const item of items || []) {
    const listingId = item?.listingId ?? item?.id ?? null;
    if (listingId == null) {
      continue;
    }

    deduped.set(String(listingId), item);
  }

  return [...deduped.values()];
}

function resolveListingPageNumber(responseUrl, payload) {
  const candidates = [
    payload?.currentPage,
    parseUrl(responseUrl)?.searchParams.get('currentPage'),
    parseUrl(responseUrl)?.searchParams.get('page'),
    parseUrl(responseUrl)?.searchParams.get('pageNumber'),
    parseUrl(responseUrl)?.searchParams.get('p'),
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }
  }

  return null;
}

function buildListingResponseSummary(responseUrl, payload) {
  const items = extractListingItemsFromPayload(payload);
  const parsedUrl = parseUrl(responseUrl);
  const pageNumber = resolveListingPageNumber(responseUrl, payload);
  const firstItem = items[0] || {};

  return {
    responseUrl,
    path: parsedUrl?.pathname || getEventRequestPath(responseUrl),
    query: selectQuerySummary(parsedUrl),
    currentPage: pageNumber,
    totalCount: Number.isFinite(Number(payload?.totalCount)) ? Number(payload.totalCount) : null,
    itemCount: items.length,
    firstListingId: firstItem.id ?? firstItem.listingId ?? null,
    observedAt: new Date().toISOString(),
  };
}

function getListingBatchKey(summary) {
  if (summary.currentPage != null) {
    return `page:${summary.currentPage}`;
  }

  const queryPairs = Object.entries(summary.query || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  return `request:${summary.path}?${queryPairs.join('&')}`;
}

function shouldReplaceListingBatch(existing, candidate) {
  if (!existing) {
    return true;
  }

  if ((candidate.itemCount || 0) !== (existing.itemCount || 0)) {
    return (candidate.itemCount || 0) > (existing.itemCount || 0);
  }

  if ((candidate.totalCount || 0) !== (existing.totalCount || 0)) {
    return (candidate.totalCount || 0) > (existing.totalCount || 0);
  }

  return candidate.observedAt > existing.observedAt;
}

function recordListingBatchObservation(listingBatchState, summary, items) {
  const observation = {
    ...summary,
    selected: false,
  };
  listingBatchState.observations.push(observation);
  if (listingBatchState.observations.length > LISTING_OBSERVATION_LIMIT) {
    listingBatchState.observations.shift();
  }

  if (!items.length) {
    return;
  }

  const batchKey = getListingBatchKey(summary);
  const candidate = {
    ...summary,
    batchKey,
    items,
  };
  const existing = listingBatchState.batchesByKey.get(batchKey);
  if (existing && (
    existing.itemCount !== candidate.itemCount
    || existing.totalCount !== candidate.totalCount
    || existing.firstListingId !== candidate.firstListingId
  )) {
    listingBatchState.conflicts.push({
      batchKey,
      currentPage: candidate.currentPage,
      previousItemCount: existing.itemCount,
      nextItemCount: candidate.itemCount,
      previousTotalCount: existing.totalCount,
      nextTotalCount: candidate.totalCount,
      previousFirstListingId: existing.firstListingId,
      nextFirstListingId: candidate.firstListingId,
    });
  }

  if (shouldReplaceListingBatch(existing, candidate)) {
    if (existing) {
      listingBatchState.replacements.push({
        batchKey,
        currentPage: candidate.currentPage,
        previousItemCount: existing.itemCount,
        nextItemCount: candidate.itemCount,
        previousTotalCount: existing.totalCount,
        nextTotalCount: candidate.totalCount,
      });
    }
    listingBatchState.batchesByKey.set(batchKey, candidate);
    listingBatchState.version += 1;
  }
}

function summarizeSelectedListingBatches(listingBatchState) {
  return [...listingBatchState.batchesByKey.values()]
    .sort((left, right) => {
      if (left.currentPage != null && right.currentPage != null) {
        return left.currentPage - right.currentPage;
      }
      if (left.currentPage != null) {
        return -1;
      }
      if (right.currentPage != null) {
        return 1;
      }
      return left.batchKey.localeCompare(right.batchKey);
    })
    .map(({ items, ...summary }) => summary);
}

function buildListingStateFingerprint(progress, listingBatchState) {
  return JSON.stringify({
    shownCount: progress?.shownCount ?? null,
    totalCount: progress?.totalCount ?? null,
    hasShowMore: Boolean(progress?.hasShowMore),
    version: listingBatchState.version,
  });
}

async function getListingProgress(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const progressMatch = text.match(/Showing\s+(\d+)\s+of\s+(\d+)/i);
    const totalMatch = text.match(/(\d+)\s+listings/i);
    const hasShowMore = [...document.querySelectorAll('button, a, [role="button"]')]
      .some((item) => /show more/i.test((item.innerText || item.textContent || '').trim()));

    return {
      shownCount: progressMatch ? Number(progressMatch[1]) : null,
      totalCount: progressMatch ? Number(progressMatch[2]) : (totalMatch ? Number(totalMatch[1]) : null),
      hasShowMore,
    };
  });
}

async function clickShowMore(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
    const button = nodes.find((item) => /show more/i.test((item.innerText || item.textContent || '').trim()));
    if (!button) {
      return false;
    }

    button.click();
    return true;
  });
}

async function waitForListingStateStabilized(page, listingBatchState, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000);
  const stableWindowMs = Math.max(250, Number(options.stableWindowMs) || 1500);
  const startedAt = Date.now();
  let progress = await getListingProgress(page);
  let fingerprint = buildListingStateFingerprint(progress, listingBatchState);
  let lastChangedAt = Date.now();
  let changed = false;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, LISTING_PROGRESS_POLL_MS));
    progress = await getListingProgress(page);
    const nextFingerprint = buildListingStateFingerprint(progress, listingBatchState);
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      lastChangedAt = Date.now();
      changed = true;
      continue;
    }

    if (Date.now() - lastChangedAt >= stableWindowMs) {
      return {
        progress,
        stabilized: true,
        changed,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  return {
    progress: await getListingProgress(page),
    stabilized: false,
    changed,
    durationMs: Date.now() - startedAt,
  };
}

async function collectAllListingItems(page, target, initialJson, listingBatchState, config) {
  const source = getVenueMapSource(initialJson);
  const initialItems = dedupeListingItems(source?.gridItems || []);
  const settleEvents = [];
  const warnings = [];
  let progress = await getListingProgress(page);
  let clickCount = 0;

  while (
    progress.hasShowMore &&
    progress.shownCount != null &&
    progress.totalCount != null &&
    progress.shownCount < progress.totalCount &&
    clickCount < MAX_SHOW_MORE_CLICKS
  ) {
    const clicked = await clickShowMore(page);
    if (!clicked) {
      break;
    }

    clickCount += 1;
    const settleResult = await waitForListingStateStabilized(page, listingBatchState, {
      timeoutMs: config.listingProgressTimeoutMs,
      stableWindowMs: config.listingStableWindowMs,
    });
    progress = settleResult.progress;
    settleEvents.push({
      phase: `click_${clickCount}`,
      ...settleResult,
    });

    if (!settleResult.changed) {
      warnings.push(`show_more_click_${clickCount}_produced_no_listing_state_change`);
      break;
    }
  }

  const finalSettle = await waitForListingStateStabilized(page, listingBatchState, {
    timeoutMs: config.listingFinalSettleTimeoutMs,
    stableWindowMs: config.listingStableWindowMs,
  });
  const finalProgress = finalSettle.progress;
  const selectedBatches = summarizeSelectedListingBatches(listingBatchState);
  const extraItems = dedupeListingItems([...listingBatchState.batchesByKey.values()].flatMap((batch) => batch.items));
  const listingItems = dedupeListingItems([...initialItems, ...extraItems]);
  if (finalProgress.totalCount != null && listingItems.length !== finalProgress.totalCount) {
    warnings.push(`listing_count_mismatch:${listingItems.length}/${finalProgress.totalCount}`);
  }
  if (listingBatchState.conflicts.length > 0) {
    warnings.push(`listing_batch_conflicts:${listingBatchState.conflicts.length}`);
  }

  return {
    listingItems,
    progress: finalProgress,
    clickCount,
    batchCount: selectedBatches.length,
    selectedBatches,
    observations: listingBatchState.observations,
    conflicts: listingBatchState.conflicts,
    replacements: listingBatchState.replacements,
    settleEvents,
    finalSettle,
    warnings,
  };
}

async function extractAllSectionsFromJSON(jsonData, sectionIdToMapNameFromSvg = {}) {
  console.log('🎯 Extracting sections from index-data...');
  const source = getVenueMapSource(jsonData);
  if (!source) {
    throw new Error('Missing venueConfiguration in intercepted JSON');
  }

  console.log(`   📍 Using JSON branch: ${source.label}`);
  const fallbackRowPopupData = buildFallbackRowPopupData(source.sectionPopupData, source.gridItems);

  const sectionIdToVenueEntries = {};
  for (const venueData of Object.values(source.venueConfiguration || {})) {
    const sectionId = venueData.sectionId;
    if (sectionId == null) {
      continue;
    }

    if (!sectionIdToVenueEntries[sectionId]) {
      sectionIdToVenueEntries[sectionId] = [];
    }

    sectionIdToVenueEntries[sectionId].push({
      sectionId,
      sectionName: venueData.sectionName || null,
      ticketClassId: venueData.ticketClassId ?? null,
      rows: Array.isArray(venueData.rows) ? venueData.rows : [],
    });
  }

  const sectionIdToMapName = { ...sectionIdToMapNameFromSvg };
  if (Object.keys(sectionIdToMapName).length === 0) {
    for (const item of source.gridItems || []) {
      if (item.sectionId != null && item.sectionMapName != null) {
        sectionIdToMapName[item.sectionId] = item.sectionMapName;
      }
    }
  }

  const results = new Map();
  const sectionIds = new Set([
    ...Object.keys(sectionIdToVenueEntries).map((value) => Number(value)),
    ...Object.keys(sectionIdToMapName).map((value) => Number(value)),
  ]);

  for (const sectionId of [...sectionIds].sort((left, right) => left - right)) {
    const entries = sectionIdToVenueEntries[sectionId] || [];
    const sectionMapName = sectionIdToMapName[sectionId] || null;

    if (entries.length === 0) {
      upsertSectionRecord(
        results,
        buildRowRecord({
          sectionId,
          sectionName: sectionMapName || `Section ${sectionId}`,
          sectionMapName,
          ticketClassId: null,
          rowId: null,
          rowPopupEntry: null,
        }),
      );
      continue;
    }

    for (const entry of entries) {
      const sectionName = entry.sectionName || sectionMapName || `Section ${sectionId}`;

      if (entry.rows.length === 0) {
        upsertSectionRecord(
          results,
          buildRowRecord({
            sectionId,
            sectionName,
            sectionMapName,
            ticketClassId: entry.ticketClassId,
            rowId: null,
            rowPopupEntry: null,
          }),
        );
        continue;
      }

      for (const rowId of entry.rows) {
        const rowKey = `${entry.ticketClassId}_${sectionId}_${rowId}`;
        upsertSectionRecord(
          results,
          buildRowRecord({
            sectionId,
            sectionName,
            sectionMapName,
            ticketClassId: entry.ticketClassId,
            rowId,
            rowPopupEntry: source.rowPopupData[rowKey] || fallbackRowPopupData[rowKey] || null,
          }),
        );
      }
    }
  }

  const sections = [...results.values()];
  console.log(`   ✅ Extracted ${sections.length} normalized row/section record(s)`);
  return sections;
}

async function extractSectionNamesFromPage(page) {
  const extractFromDocument = () => {
    const mapping = {};
    const base = document.querySelector('#section-map-base');
    const scope = base || document.querySelector('svg') || document;
    const textNodes = scope.querySelectorAll('text');

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.tagName?.toUpperCase() !== 'G') {
        continue;
      }

      const spriteIdentifier = parent.getAttribute('sprite-identifier');
      if (!spriteIdentifier || !spriteIdentifier.startsWith('s')) {
        continue;
      }

      const sectionId = Number.parseInt(spriteIdentifier.slice(1).trim(), 10);
      if (Number.isNaN(sectionId)) {
        continue;
      }

      const name = textNode.textContent.trim();
      if (name && !mapping[sectionId]) {
        mapping[sectionId] = name;
      }
    }

    return mapping;
  };

  const fromMainDocument = await page.evaluate(extractFromDocument);
  if (Object.keys(fromMainDocument).length > 0) {
    return fromMainDocument;
  }

  for (const frame of page.frames()) {
    try {
      const fromFrame = await frame.evaluate(extractFromDocument);
      if (Object.keys(fromFrame).length > 0) {
        return fromFrame;
      }
    } catch (error) {
      continue;
    }
  }

  return {};
}

async function extractPageDetails(page) {
  const pageDetails = await page.evaluate(() => {
    const getMeta = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || null;

    let structuredData = null;
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      const content = node.textContent?.trim();
      if (!content) {
        continue;
      }

      try {
        const parsed = JSON.parse(content);
        const values = Array.isArray(parsed) ? parsed : [parsed];
        structuredData = values.find((item) => {
          const type = item['@type'];
          return type === 'Event' || (Array.isArray(type) && type.includes('Event'));
        }) || structuredData;
      } catch (error) {
        continue;
      }
    }

    const location = structuredData?.location?.name || structuredData?.location?.address?.addressLocality || null;

    return {
      title: document.title?.trim() || null,
      ogTitle: getMeta('meta[property="og:title"]'),
      ogImage: getMeta('meta[property="og:image"]'),
      eventName: structuredData?.name || null,
      eventDate: structuredData?.startDate || null,
      eventLocation: location,
      eventImage: structuredData?.image || null,
    };
  });

  return {
    name:
      normalizeWhitespace(pageDetails.eventName) ||
      normalizeWhitespace(pageDetails.ogTitle) ||
      normalizeWhitespace(pageDetails.title?.replace(/\s*\|\s*Viagogo.*$/i, '')),
    date: toIsoDate(pageDetails.eventDate),
    location: normalizeWhitespace(pageDetails.eventLocation),
    imageUrl: normalizeWhitespace(pageDetails.eventImage || pageDetails.ogImage),
  };
}

function mergeEventDetails(target, pageDetails) {
  return {
    name: target.name || pageDetails.name || 'Unknown Event',
    date: target.date || pageDetails.date || null,
    location: target.location || pageDetails.location || null,
    imageUrl: target.imageUrl || pageDetails.imageUrl || null,
  };
}

function classifyFailureReason(error) {
  const message = String(error.message || error).toLowerCase();

  if (message.includes('timeout')) {
    return 'timeout';
  }

  if (message.includes('403') || message.includes('captcha') || message.includes('turnstile') || message.includes('blocked')) {
    return 'anti_bot_blocked';
  }

  if (message.includes('missing venueconfiguration') || message.includes('no sections')) {
    return 'json_shape_drift';
  }

  if (message.includes('invalid url')) {
    return 'invalid_event_url';
  }

  return 'unexpected_error';
}

async function dumpRawPayload(config, target, runId, payload, suffix = 'parse-failure') {
  if (!config.dumpRawPayloadOnFailure || !payload) {
    return null;
  }

  const eventId = buildEventIdFromUrl(target.url) || 'unknown-event';
  const fileName = `${eventId}-${runId}-${suffix}.json`;
  const targetDir = path.resolve(config.rawPayloadDumpDir);
  await fs.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, fileName);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

async function scrapeEventTarget(target, config, runId) {
  let browser = null;
  let interceptedJsonData = null;
  const listingBatchState = {
    batchesByKey: new Map(),
    observations: [],
    conflicts: [],
    replacements: [],
    version: 0,
  };
  let resolveJsonData;
  const jsonDataPromise = new Promise((resolve) => {
    resolveJsonData = resolve;
  });

  try {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`🎫 Processing target: ${target.name || target.url}`);
    console.log(`   Mode: ${target.sourceMode}`);
    if (target.linkId != null) {
      console.log(`   vgg_links.id: ${target.linkId}`);
    }
    console.log(`${'='.repeat(72)}`);

    const connection = await connect({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
      ],
      customConfig: {},
      turnstile: true,
      connectOption: {},
      disableXvfb: false,
      ignoreAllFlags: false,
    });

    browser = connection.browser;
    const { page } = connection;

    const userAgent = resolveUserAgent(config);
    await page.setUserAgent(userAgent);
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    });

    console.log(`🔧 User-Agent: ${truncate(userAgent, 80)}`);

    await page.setRequestInterception(true);
    page.on('request', (request) => request.continue());
    page.on('response', async (response) => {
      const responseUrl = response.url();
      const contentType = response.headers()['content-type'] || '';
      const resourceType = response.request().resourceType();

      try {
        if (isEventListingJsonResponse(responseUrl, target.url, contentType, resourceType)) {
          const payload = JSON.parse(await response.text());
          const items = extractListingItemsFromPayload(payload);
          const responseSummary = buildListingResponseSummary(responseUrl, payload);
          recordListingBatchObservation(listingBatchState, responseSummary, items);
          return;
        }

        if (interceptedJsonData) {
          return;
        }

        if (!contentType.includes('text/html') || !/\/E-\d+(?:$|[?#])/.test(responseUrl)) {
          return;
        }

        const html = await response.text();
        const $ = cheerio.load(html);
        const scriptContent = $('#index-data').html();
        if (!scriptContent) {
          return;
        }

        interceptedJsonData = JSON.parse(scriptContent);
        resolveJsonData(interceptedJsonData);
        console.log(`🎯 Intercepted index-data from ${responseUrl}`);
      } catch (error) {
        console.warn(`⚠️ Failed to parse intercepted HTML response: ${error.message}`);
      }
    });

    console.log('🌐 Navigating to event page...');
    await page.goto(target.url, {
      waitUntil: ['domcontentloaded'],
      timeout: config.navigationTimeoutMs,
    });

    await randomDelay(config.pageSettleDelayMinMs, config.pageSettleDelayMaxMs);

    try {
      await page.waitForSelector('body', { timeout: 10000 });
    } catch (error) {
      console.warn('⚠️ Body selector timeout, continuing with partial page state.');
    }

    try {
      await page.waitForSelector('#section-map-base', { timeout: config.sectionMapTimeoutMs });
      console.log('✅ Section map found');
    } catch (error) {
      console.warn('⚠️ SVG section map not found before timeout, continuing.');
    }

    interceptedJsonData = await Promise.race([
      jsonDataPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('index-data intercept timeout')), config.jsonInterceptTimeoutMs)),
    ]);

    await randomDelay(config.postInterceptDelayMinMs, config.postInterceptDelayMaxMs);

    const mapNames = await extractSectionNamesFromPage(page);
    console.log(`🗺️ Map section labels collected: ${Object.keys(mapNames).length}`);

    const sections = await extractAllSectionsFromJSON(interceptedJsonData, mapNames);
    if (sections.length === 0) {
      throw new Error('No sections extracted from JSON payload');
    }

    const listingCollection = await collectAllListingItems(page, target, interceptedJsonData, listingBatchState, config);
    if (listingCollection.conflicts.length > 0) {
      console.warn(`⚠️ Conflicting listing batch responses detected: ${listingCollection.conflicts.length}`);
    }
    if (listingCollection.warnings.length > 0) {
      console.warn(`⚠️ Listing collection warnings: ${listingCollection.warnings.join(', ')}`);
    }
    console.log(
      `🧾 Listing pages loaded: initial=${getVenueMapSource(interceptedJsonData)?.gridItems?.length || 0}, extraPages=${listingCollection.batchCount}, totalListings=${listingCollection.listingItems.length}`,
    );

    const pageDetails = await extractPageDetails(page);
    const eventDetails = mergeEventDetails(target, pageDetails);
    const eventId = target.eventId || buildEventIdFromUrl(target.url);
    const capturedAt = new Date().toISOString();

    const snapshot = buildInventorySnapshot({
      linkId: target.linkId,
      eventId,
      eventUrl: target.url,
      eventDetails,
      sections,
      listingItems: listingCollection.listingItems,
      capturedAt,
      meta: {
        mapSectionCount: Object.keys(mapNames).length,
        rawSectionRecordCount: sections.length,
        listingBatchCount: listingCollection.batchCount,
        listingShowMoreClicks: listingCollection.clickCount,
        listingProgress: listingCollection.progress,
        scraperUserAgent: userAgent,
        listingObservationWarnings: listingCollection.warnings,
        listingResponseObservations: listingCollection.observations,
        selectedListingBatches: listingCollection.selectedBatches,
        listingBatchConflicts: listingCollection.conflicts,
        listingBatchReplacements: listingCollection.replacements,
        listingSettleEvents: listingCollection.settleEvents,
        listingFinalSettle: listingCollection.finalSettle,
        runId,
      },
    });

    console.log(
      `📦 Snapshot built: rows=${snapshot.summary.rowsTracked}, rowsWithStock=${snapshot.summary.rowsWithStock}, totalListings=${snapshot.summary.totalListingCount}, totalTickets=${snapshot.summary.totalTicketCount}`,
    );

    return {
      success: true,
      snapshot,
      rawJson: interceptedJsonData,
    };
  } catch (error) {
    const failureType = classifyFailureReason(error);
    const payloadPath = await dumpRawPayload(config, target, runId, interceptedJsonData, failureType).catch(() => null);
    console.error(`❌ Scrape failed (${failureType}): ${error.message}`);
    if (payloadPath) {
      console.error(`   Raw payload dumped to ${payloadPath}`);
    }

    return {
      success: false,
      failureType,
      reason: error.message,
      rawPayloadPath: payloadPath,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  buildListingResponseSummary,
  extractAllSectionsFromJSON,
  isEventListingJsonResponse,
  scrapeEventTarget,
  shouldReplaceListingBatch,
};
