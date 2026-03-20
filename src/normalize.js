const {
  buildEventIdFromUrl,
  normalizeWhitespace,
  toIsoDate,
} = require('./utils');

const NOISY_SPECULATIVE_ROW_LABELS = new Set(['row', 'chair', 'ok', '排']);
const LISTING_SEAT_PLACEHOLDERS = new Set(['_', '-', '--']);

function normalizeRowId(rowId) {
  if (rowId == null) {
    return null;
  }

  return normalizeWhitespace(String(rowId)) || null;
}

function normalizeSectionName(section) {
  return (
    normalizeWhitespace(section.sectionMapName) ||
    normalizeWhitespace(section.sectionName) ||
    (section.sectionId != null ? `Section ${section.sectionId}` : 'Unknown Section')
  );
}

function normalizeListingId(listingId) {
  if (listingId == null) {
    return null;
  }

  return normalizeWhitespace(String(listingId)) || null;
}

function normalizeListingStableKey(item) {
  const aipHash = normalizeWhitespace(item?.aipHash);
  return aipHash || normalizeListingId(item?.listingId ?? item?.id);
}

function buildStableRowKey(section) {
  const normalizedRowId = normalizeRowId(section.rowId);
  const sectionId = section.sectionId != null ? String(section.sectionId) : 'unknown-section';
  const ticketClassId = section.ticketClassId != null ? String(section.ticketClassId) : 'unknown-class';

  if (!normalizedRowId) {
    return null;
  }

  return `${ticketClassId}_${sectionId}_${normalizedRowId}`;
}

function toNullableNumber(value) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSectionKey(section) {
  if (section.sectionId != null) {
    return String(section.sectionId);
  }

  return normalizeSectionName(section);
}

function inferCurrency(section) {
  const candidate =
    section.rowPopupEntry?.currencyCode ||
    section.rowPopupEntry?.currency ||
    section.currency ||
    null;

  if (candidate) {
    return String(candidate).trim().toUpperCase();
  }

  const formatted = normalizeWhitespace(section.priceFormatted);
  if (!formatted) {
    return null;
  }

  if (formatted.startsWith('£')) {
    return 'GBP';
  }
  if (formatted.startsWith('€')) {
    return 'EUR';
  }
  if (formatted.startsWith('$')) {
    return 'USD';
  }
  return null;
}

function normalizeListingSeat(...values) {
  for (const value of values) {
    const normalized = normalizeWhitespace(value == null ? null : String(value));
    if (!normalized || LISTING_SEAT_PLACEHOLDERS.has(normalized)) {
      continue;
    }
    return normalized;
  }

  return null;
}

function normalizeListingRowContent(rowContent) {
  const normalized = normalizeWhitespace(rowContent);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^Row\s+(.+)$/i);
  return normalizeWhitespace(match ? match[1] : normalized);
}

function isNoisySpeculativeRowLabel(rowLabel) {
  const normalized = normalizeWhitespace(rowLabel == null ? null : String(rowLabel));
  if (!normalized) {
    return false;
  }

  return NOISY_SPECULATIVE_ROW_LABELS.has(normalized.toLowerCase());
}

function normalizeListingRowId(item, seat) {
  const candidates = [
    normalizeWhitespace(item?.row),
    normalizeListingRowContent(item?.rowContent),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (item?.isSpeculativeRow && !seat && isNoisySpeculativeRowLabel(candidate)) {
      continue;
    }

    return candidate;
  }

  return null;
}

function mergeUniqueStrings(values = []) {
  const merged = [];
  const seen = new Set();

  for (const value of values) {
    const normalized = normalizeWhitespace(value == null ? null : String(value));
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    merged.push(normalized);
  }

  return merged;
}

function sortListingIds(values = []) {
  return [...values].sort((left, right) => {
    const leftText = String(left);
    const rightText = String(right);
    const leftNumber = Number(leftText);
    const rightNumber = Number(rightText);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }

    return leftText.localeCompare(rightText);
  });
}

function choosePreferredRowId(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left;
  }

  if (isNoisySpeculativeRowLabel(left) && !isNoisySpeculativeRowLabel(right)) {
    return right;
  }
  if (isNoisySpeculativeRowLabel(right) && !isNoisySpeculativeRowLabel(left)) {
    return left;
  }

  return left.length <= right.length ? left : right;
}

function mergeListingRecords(existing, next) {
  const sourceListingIds = sortListingIds(
    mergeUniqueStrings([
      ...(existing.sourceListingIds || []),
      ...(next.sourceListingIds || []),
    ]),
  );
  const rawPrice =
    typeof existing.rawPrice === 'number' && typeof next.rawPrice === 'number'
      ? Math.min(existing.rawPrice, next.rawPrice)
      : (existing.rawPrice ?? next.rawPrice ?? null);

  return {
    ...existing,
    listingId: sourceListingIds[0] || existing.listingId || next.listingId || null,
    sourceListingIds,
    rowId: choosePreferredRowId(existing.rowId, next.rowId),
    rowInternalId: existing.rowInternalId || next.rowInternalId || null,
    seat: existing.seat || next.seat || null,
    availableTickets: Math.max(existing.availableTickets || 0, next.availableTickets || 0),
    rawPrice,
    formattedPrice: existing.formattedPrice || next.formattedPrice || null,
    currencyCode: existing.currencyCode || next.currencyCode || null,
    ticketTypeName: existing.ticketTypeName || next.ticketTypeName || null,
    listingTypeId: existing.listingTypeId ?? next.listingTypeId ?? null,
    listingNotes: mergeUniqueStrings([...(existing.listingNotes || []), ...(next.listingNotes || [])]),
    createdDateTime: existing.createdDateTime || next.createdDateTime || null,
    duplicateSourceCount: Math.max(existing.duplicateSourceCount || 1, sourceListingIds.length),
  };
}

function normalizeListingRecord(item) {
  const listingKey = normalizeListingStableKey(item);
  const listingId = normalizeListingId(item.listingId ?? item.id);
  if (!listingKey || !listingId) {
    return null;
  }

  const seat = normalizeListingSeat(item.seat, item.seatFromInternal);
  const rowId = normalizeListingRowId(item, seat);

  return {
    listingKey,
    listingId,
    sourceListingIds: [listingId],
    sectionId: item.sectionId ?? null,
    sectionName:
      normalizeWhitespace(item.sectionMapName) ||
      normalizeWhitespace(item.section) ||
      normalizeWhitespace(item.ticketClassName) ||
      'Unknown Section',
    rowId,
    rowInternalId: item.rowId != null ? normalizeWhitespace(String(item.rowId)) : null,
    seat,
    ticketClassId: item.ticketClass ?? item.ticketClassId ?? null,
    ticketClassName: normalizeWhitespace(item.ticketClassName) || null,
    availableTickets: Math.max(0, toNullableNumber(item.availableTickets ?? item.ticketCount) || 0),
    rawPrice: toNullableNumber(item.rawPrice ?? item.rawMinPrice ?? item.priceValue),
    formattedPrice:
      normalizeWhitespace(item.price) ||
      normalizeWhitespace(item.formattedMinPrice) ||
      normalizeWhitespace(item.formattedPrice) ||
      null,
    currencyCode:
      normalizeWhitespace(item.buyerCurrencyCode || item.currencyCode || item.listingCurrencyCode)?.toUpperCase() || null,
    ticketTypeName: normalizeWhitespace(item.ticketTypeName) || null,
    listingTypeId: item.listingTypeId ?? null,
    listingNotes: Array.isArray(item.listingNotes)
      ? item.listingNotes
          .map((note) => normalizeWhitespace(note?.formattedListingNoteContent || note?.listingNoteContent))
          .filter(Boolean)
      : [],
    createdDateTime: item.createdDateTime || null,
    aipHash: normalizeWhitespace(item.aipHash) || null,
    duplicateSourceCount: 1,
  };
}

function buildListingMap(listingItems = []) {
  const listings = {};
  const stableListings = {};
  let rawMinPrice = null;
  let rawTotalTicketCount = 0;
  let rawCurrency = null;

  for (const item of listingItems || []) {
    const listing = normalizeListingRecord(item);
    if (!listing) {
      continue;
    }

    rawTotalTicketCount += listing.availableTickets;
    if (listing.rawPrice != null && (rawMinPrice == null || listing.rawPrice < rawMinPrice)) {
      rawMinPrice = listing.rawPrice;
    }
    rawCurrency = rawCurrency || listing.currencyCode || null;
    listings[listing.listingId] = listing;

    const existing = stableListings[listing.listingKey];
    stableListings[listing.listingKey] = existing
      ? mergeListingRecords(existing, listing)
      : listing;
  }

  let stableMinPrice = null;
  let stableTotalTicketCount = 0;
  let stableCurrency = null;
  for (const listing of Object.values(stableListings)) {
    stableTotalTicketCount += listing.availableTickets;
    if (listing.rawPrice != null && (stableMinPrice == null || listing.rawPrice < stableMinPrice)) {
      stableMinPrice = listing.rawPrice;
    }
    stableCurrency = stableCurrency || listing.currencyCode || null;
  }

  const rawListingCount = Object.keys(listings).length;
  const stableListingCount = Object.keys(stableListings).length;

  return {
    listings,
    stableListings,
    rawListingCount,
    rawTotalTicketCount,
    rawMinPrice,
    rawCurrency,
    stableListingCount,
    stableTotalTicketCount,
    stableMinPrice,
    stableCurrency,
    collapsedDuplicateListingCount: Math.max(0, rawListingCount - stableListingCount),
  };
}

function buildInventorySnapshot({ eventUrl, eventId, linkId = null, eventDetails = {}, sections = [], listingItems = [], capturedAt, source = 'event_page_json', meta = {} }) {
  const rows = {};
  const sectionSummary = {};
  let minPrice = null;
  let totalListingCount = 0;
  let totalTicketCount = 0;
  let currency = null;

  for (const section of sections) {
    const sectionKey = buildSectionKey(section);
    const sectionName = normalizeSectionName(section);
    if (!sectionSummary[sectionKey]) {
      sectionSummary[sectionKey] = {
        sectionId: section.sectionId ?? null,
        sectionName,
        rowsTracked: 0,
        rowsWithStock: 0,
        totalListingCount: 0,
        totalTicketCount: 0,
        hasStock: false,
        dataNotFound: false,
      };
    }

    const sectionEntry = sectionSummary[sectionKey];
    if (section.dataNotFound && section.rowId == null) {
      sectionEntry.dataNotFound = true;
      continue;
    }

    const rowId = normalizeRowId(section.rowId);
    const rowKey = buildStableRowKey({ ...section, rowId });
    if (!rowKey) {
      continue;
    }

    const rawMinPrice = toNullableNumber(section.price);
    const ticketCount = Math.max(0, toNullableNumber(section.ticketCount) || 0);
    const listingCount = Math.max(0, toNullableNumber(section.listingCount) || 0);
    const formattedMinPrice = normalizeWhitespace(section.priceFormatted);

    rows[rowKey] = {
      sectionId: section.sectionId ?? null,
      sectionName,
      rowId,
      ticketClassId: section.ticketClassId ?? null,
      ticketCount,
      rawMinPrice,
      formattedMinPrice,
      listingCount,
      dataNotFound: Boolean(section.dataNotFound),
    };

    sectionEntry.rowsTracked += 1;
    sectionEntry.totalListingCount += listingCount;
    sectionEntry.totalTicketCount += ticketCount;
    totalListingCount += listingCount;
    if (ticketCount > 0) {
      sectionEntry.rowsWithStock += 1;
      sectionEntry.hasStock = true;
      totalTicketCount += ticketCount;
      if (rawMinPrice != null && (minPrice == null || rawMinPrice < minPrice)) {
        minPrice = rawMinPrice;
      }
    }

    currency = currency || inferCurrency(section);
  }

  const sectionsTracked = Object.keys(sectionSummary).length;
  const sectionsWithStock = Object.values(sectionSummary).filter((section) => section.hasStock).length;
  const rowsTracked = Object.keys(rows).length;
  const rowsWithStock = Object.values(rows).filter((row) => row.ticketCount > 0).length;
  const listingSummary = buildListingMap(listingItems);

  if (listingSummary.stableListingCount > 0) {
    totalListingCount = listingSummary.rawListingCount;
    totalTicketCount = listingSummary.rawTotalTicketCount;
    minPrice = listingSummary.rawMinPrice;
    currency = listingSummary.rawCurrency || currency;
  }

  return {
    linkId,
    eventId: eventId || buildEventIdFromUrl(eventUrl) || 'unknown-event',
    eventUrl,
    capturedAt: capturedAt || new Date().toISOString(),
    source,
    event: {
      name: normalizeWhitespace(eventDetails.name) || 'Unknown Event',
      date: toIsoDate(eventDetails.date),
      location: normalizeWhitespace(eventDetails.location),
      imageUrl: normalizeWhitespace(eventDetails.imageUrl),
    },
    summary: {
      rowsTracked,
      rowsWithStock,
      sectionsTracked,
      sectionsWithStock,
      totalListingCount,
      totalTicketCount,
      stableListingCount: listingSummary.stableListingCount,
      stableTotalTicketCount: listingSummary.stableTotalTicketCount,
      minPrice,
      currency,
    },
    sections: sectionSummary,
    rows,
    listings: listingSummary.listings,
    stableListings: listingSummary.stableListings,
    meta: {
      ...meta,
      comparisonEntity: listingSummary.stableListingCount > 0 ? 'listing' : 'row',
      collectedListingCount: listingSummary.stableListingCount,
      rawListingCount: listingSummary.rawListingCount,
      stableListingCount: listingSummary.stableListingCount,
      collapsedDuplicateListingCount: listingSummary.collapsedDuplicateListingCount,
    },
  };
}

function buildCompatibilitySnapshot({ eventUrl, linkId = null, eventId = null, eventDetails = {}, previousPrices = {}, capturedAt = null }) {
  const sections = [];

  for (const [rowKey, value] of Object.entries(previousPrices || {})) {
    const match = rowKey.match(/^(.+?)_(.+?)_(.+)$/);
    const ticketClassId = match ? match[1] : null;
    const sectionId = match ? match[2] : null;
    const rowId = match ? match[3] : rowKey;
    const priceObject = typeof value === 'object' && value !== null ? value : { rawMinPrice: value };

    sections.push({
      sectionId,
      sectionName: priceObject.sectionName || (sectionId != null ? `Section ${sectionId}` : 'Unknown Section'),
      sectionMapName: priceObject.sectionName || null,
      ticketClassId,
      rowId,
      rowKey,
      price: toNullableNumber(priceObject.rawMinPrice),
      priceFormatted: priceObject.formattedMinPrice || null,
      ticketCount: Math.max(0, toNullableNumber(priceObject.ticketCount) || 0),
      listingCount: Math.max(0, toNullableNumber(priceObject.listingCount) || 0),
      dataNotFound: Boolean(priceObject.dataNotFound),
      rowPopupEntry: priceObject,
    });
  }

  return buildInventorySnapshot({
    eventUrl,
    eventId: eventId || buildEventIdFromUrl(eventUrl),
    linkId,
    eventDetails,
    sections,
    capturedAt,
    source: 'compatibility_previousprices',
    meta: {
      compatibilityCache: true,
    },
  });
}

function buildPreviousPricesCache(snapshot) {
  const cache = {};

  for (const [rowKey, row] of Object.entries(snapshot.rows || {})) {
    cache[rowKey] = {
      sectionName: row.sectionName,
      ticketCount: row.ticketCount,
      rawMinPrice: row.rawMinPrice,
      formattedMinPrice: row.formattedMinPrice,
      listingCount: row.listingCount,
      dataNotFound: row.dataNotFound,
    };
  }

  return cache;
}

module.exports = {
  buildCompatibilitySnapshot,
  buildInventorySnapshot,
  buildPreviousPricesCache,
  normalizeListingId,
  normalizeListingStableKey,
  buildStableRowKey,
};
