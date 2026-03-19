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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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

    const userAgent = getRandomUserAgent();
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

      if (interceptedJsonData) {
        return;
      }

      if (!contentType.includes('text/html') || !/\/E-\d+(?:$|[?#])/.test(responseUrl)) {
        return;
      }

      try {
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
      capturedAt,
      meta: {
        mapSectionCount: Object.keys(mapNames).length,
        rawSectionRecordCount: sections.length,
        runId,
      },
    });

    console.log(`📦 Snapshot built: rows=${snapshot.summary.rowsTracked}, rowsWithStock=${snapshot.summary.rowsWithStock}, totalTickets=${snapshot.summary.totalTicketCount}`);

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
  extractAllSectionsFromJSON,
  scrapeEventTarget,
};
