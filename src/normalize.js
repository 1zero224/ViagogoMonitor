const {
  buildEventIdFromUrl,
  normalizeWhitespace,
  toIsoDate,
} = require('./utils');

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

function normalizeListingRecord(item) {
  const listingId = normalizeListingId(item.listingId ?? item.id);
  if (!listingId) {
    return null;
  }

  return {
    listingId,
    sectionId: item.sectionId ?? null,
    sectionName:
      normalizeWhitespace(item.sectionMapName) ||
      normalizeWhitespace(item.section) ||
      normalizeWhitespace(item.ticketClassName) ||
      'Unknown Section',
    rowId: normalizeWhitespace(item.row) || normalizeWhitespace(item.rowContent) || null,
    rowInternalId: item.rowId != null ? normalizeWhitespace(String(item.rowId)) : null,
    seat: normalizeWhitespace(item.seat) || normalizeWhitespace(item.seatFromInternal) || null,
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
  };
}

function buildListingMap(listingItems = []) {
  const listings = {};
  let minPrice = null;
  let totalTicketCount = 0;
  let currency = null;

  for (const item of listingItems || []) {
    const listing = normalizeListingRecord(item);
    if (!listing) {
      continue;
    }

    listings[listing.listingId] = listing;
  }

  for (const listing of Object.values(listings)) {
    totalTicketCount += listing.availableTickets;
    if (listing.rawPrice != null && (minPrice == null || listing.rawPrice < minPrice)) {
      minPrice = listing.rawPrice;
    }
    currency = currency || listing.currencyCode || null;
  }

  return {
    listings,
    totalListingCount: Object.keys(listings).length,
    totalTicketCount,
    minPrice,
    currency,
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

  if (listingSummary.totalListingCount > 0) {
    totalListingCount = listingSummary.totalListingCount;
    totalTicketCount = listingSummary.totalTicketCount;
    minPrice = listingSummary.minPrice;
    currency = listingSummary.currency || currency;
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
      minPrice,
      currency,
    },
    sections: sectionSummary,
    rows,
    listings: listingSummary.listings,
    meta: {
      ...meta,
      comparisonEntity: listingSummary.totalListingCount > 0 ? 'listing' : 'row',
      collectedListingCount: listingSummary.totalListingCount,
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
  buildStableRowKey,
};
