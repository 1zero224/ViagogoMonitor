const test = require('node:test');
const assert = require('node:assert/strict');

const { diffSnapshots, filterDiffForAlerts } = require('../src/diff');
const { buildInventorySnapshot } = require('../src/normalize');

function buildSnapshot(sections, capturedAt) {
  return buildInventorySnapshot({
    eventUrl: 'https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2',
    eventId: '159436715',
    capturedAt,
    eventDetails: {
      name: 'Artist Name - London',
    },
    sections,
  });
}

function buildListingSnapshot(listingItems, capturedAt) {
  return buildInventorySnapshot({
    eventUrl: 'https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2',
    eventId: '159436715',
    capturedAt,
    eventDetails: {
      name: 'Artist Name - London',
    },
    sections: [],
    listingItems,
  });
}

test('diffSnapshots classifies row additions, removals, stock changes, ticket deltas, and price changes', () => {
  const previous = buildSnapshot(
    [
      {
        sectionId: 56342,
        sectionMapName: 'M15',
        sectionName: 'M15',
        ticketClassId: 267,
        rowId: 'A',
        price: 239.22,
        priceFormatted: '£239.22',
        ticketCount: 2,
        listingCount: 1,
        rowPopupEntry: { currencyCode: 'GBP' },
        dataNotFound: false,
      },
      {
        sectionId: 56342,
        sectionMapName: 'M15',
        sectionName: 'M15',
        ticketClassId: 267,
        rowId: 'B',
        price: 310.5,
        priceFormatted: '£310.50',
        ticketCount: 1,
        listingCount: 1,
        rowPopupEntry: { currencyCode: 'GBP' },
        dataNotFound: false,
      },
      {
        sectionId: 56343,
        sectionMapName: 'M16',
        sectionName: 'M16',
        ticketClassId: 300,
        rowId: '1',
        price: null,
        priceFormatted: null,
        ticketCount: 0,
        listingCount: 0,
        rowPopupEntry: null,
        dataNotFound: true,
      },
    ],
    '2026-03-19T12:00:00.000Z',
  );

  const current = buildSnapshot(
    [
      {
        sectionId: 56342,
        sectionMapName: 'M15',
        sectionName: 'M15',
        ticketClassId: 267,
        rowId: 'A',
        price: 225,
        priceFormatted: '£225.00',
        ticketCount: 4,
        listingCount: 2,
        rowPopupEntry: { currencyCode: 'GBP' },
        dataNotFound: false,
      },
      {
        sectionId: 56343,
        sectionMapName: 'M16',
        sectionName: 'M16',
        ticketClassId: 300,
        rowId: '1',
        price: 260,
        priceFormatted: '£260.00',
        ticketCount: 2,
        listingCount: 1,
        rowPopupEntry: { currencyCode: 'GBP' },
        dataNotFound: false,
      },
      {
        sectionId: 56344,
        sectionMapName: 'M17',
        sectionName: 'M17',
        ticketClassId: 301,
        rowId: 'C',
        price: 199,
        priceFormatted: '£199.00',
        ticketCount: 3,
        listingCount: 1,
        rowPopupEntry: { currencyCode: 'GBP' },
        dataNotFound: false,
      },
    ],
    '2026-03-19T12:05:00.000Z',
  );

  const diff = diffSnapshots(previous, current, { minTicketDelta: 1 });
  const changeTypes = diff.changes.map((change) => change.type);

  assert.deepEqual(
    changeTypes.sort(),
    [
      'new_row_available',
      'price_decreased',
      'row_removed',
      'stock_appeared',
      'ticket_count_increased',
    ].sort(),
  );
  assert.equal(diff.summaryChanges.totalListingCountDelta, 2);
  assert.equal(diff.summaryChanges.totalTicketCountDelta, 6);
});

test('filterDiffForAlerts respects alert toggles', () => {
  const diff = {
    changes: [
      { type: 'new_row_available' },
      { type: 'ticket_count_decreased' },
      { type: 'price_decreased' },
    ],
    changeCount: 3,
  };

  const filtered = filterDiffForAlerts(diff, {
    alertOnStockAppear: true,
    alertOnStockDrop: false,
    alertOnPriceChange: false,
  });

  assert.equal(filtered.changeCount, 1);
  assert.equal(filtered.changes[0].type, 'new_row_available');
});

test('diffSnapshots compares listings by listingId when listing-level snapshots exist', () => {
  const previous = buildListingSnapshot(
    [
      {
        id: 111,
        sectionId: 56342,
        sectionMapName: 'M15',
        row: 'A',
        seat: '1-2',
        availableTickets: 2,
        rawPrice: 239.22,
        price: '£239.22',
        buyerCurrencyCode: 'GBP',
      },
      {
        id: 222,
        sectionId: 56343,
        sectionMapName: 'M16',
        row: 'B',
        seat: '3-4',
        availableTickets: 1,
        rawPrice: 310.5,
        price: '£310.50',
        buyerCurrencyCode: 'GBP',
      },
    ],
    '2026-03-19T12:00:00.000Z',
  );

  const current = buildListingSnapshot(
    [
      {
        id: 111,
        sectionId: 56342,
        sectionMapName: 'M15',
        row: 'A',
        seat: '1-2',
        availableTickets: 4,
        rawPrice: 225,
        price: '£225.00',
        buyerCurrencyCode: 'GBP',
      },
      {
        id: 333,
        sectionId: 56344,
        sectionMapName: 'M17',
        row: 'C',
        seat: '5-6',
        availableTickets: 3,
        rawPrice: 199,
        price: '£199.00',
        buyerCurrencyCode: 'GBP',
      },
    ],
    '2026-03-19T12:05:00.000Z',
  );

  const diff = diffSnapshots(previous, current, { minTicketDelta: 1 });
  const changeTypes = diff.changes.map((change) => change.type);

  assert.equal(diff.comparisonMode, 'listing');
  assert.deepEqual(
    changeTypes.sort(),
    [
      'listing_price_decreased',
      'listing_removed',
      'listing_ticket_count_increased',
      'new_listing_available',
    ].sort(),
  );
});

test('diffSnapshots resets baseline when previous snapshot lacks listing-level data', () => {
  const previous = buildSnapshot(
    [
      {
        sectionId: 56342,
        sectionMapName: 'M15',
        sectionName: 'M15',
        ticketClassId: 267,
        rowId: 'A',
        price: 239.22,
        priceFormatted: '£239.22',
        ticketCount: 2,
        listingCount: 1,
        rowPopupEntry: { currencyCode: 'GBP' },
        dataNotFound: false,
      },
    ],
    '2026-03-19T12:00:00.000Z',
  );

  const current = buildListingSnapshot(
    [
      {
        id: 111,
        sectionId: 56342,
        sectionMapName: 'M15',
        row: 'A',
        seat: '1-2',
        availableTickets: 2,
        rawPrice: 239.22,
        price: '£239.22',
        buyerCurrencyCode: 'GBP',
      },
    ],
    '2026-03-19T12:05:00.000Z',
  );

  const diff = diffSnapshots(previous, current, { minTicketDelta: 1 });

  assert.equal(diff.comparisonMode, 'listing');
  assert.equal(diff.baselineReset, true);
  assert.equal(diff.changeCount, 0);
});

test('diffSnapshots uses aipHash as the stable listing identity when raw listing ids rotate', () => {
  const previous = buildListingSnapshot(
    [
      {
        id: 1001,
        aipHash: 'stable-a',
        sectionId: 724540,
        sectionMapName: 'M',
        row: 'chair',
        rowContent: 'Row chair',
        rowId: 25957,
        seat: '_',
        isSpeculativeRow: true,
        availableTickets: 4,
        rawPrice: 204.08,
        price: '$204',
        buyerCurrencyCode: 'USD',
      },
    ],
    '2026-03-19T12:00:00.000Z',
  );

  const current = buildListingSnapshot(
    [
      {
        id: 2002,
        aipHash: 'stable-a',
        sectionId: 724540,
        sectionMapName: 'M',
        row: 'Row',
        rowContent: 'Row Row',
        rowId: 25957,
        seat: '_',
        isSpeculativeRow: true,
        availableTickets: 4,
        rawPrice: 199.99,
        price: '$200',
        buyerCurrencyCode: 'USD',
      },
    ],
    '2026-03-19T12:05:00.000Z',
  );

  const diff = diffSnapshots(previous, current, { minTicketDelta: 1 });

  assert.equal(diff.comparisonMode, 'listing');
  assert.deepEqual(
    diff.changes.map((change) => change.type),
    ['listing_price_decreased'],
  );
  assert.equal(diff.changes[0].listingKey, 'stable-a');
  assert.equal(diff.changes[0].listingId, '2002');
});

test('diffSnapshots resets listing baseline when the previous snapshot predates stableListings support', () => {
  const previous = {
    eventId: '159991465',
    eventUrl: 'https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?quantity=1',
    capturedAt: '2026-03-19T12:00:00.000Z',
    summary: {
      totalListingCount: 40,
      totalTicketCount: 143,
      rowsWithStock: 13,
      sectionsWithStock: 13,
      minPrice: 132.36,
    },
    listings: {
      '11411512840': {
        listingId: '11411512840',
        sectionName: 'M',
        rowId: null,
        seat: null,
        availableTickets: 4,
        rawPrice: 204.08,
      },
    },
  };

  const current = buildListingSnapshot(
    [
      {
        id: 2002,
        aipHash: 'stable-a',
        sectionId: 724540,
        sectionMapName: 'M',
        row: 'Row',
        rowContent: 'Row Row',
        rowId: 25957,
        seat: '_',
        isSpeculativeRow: true,
        availableTickets: 4,
        rawPrice: 199.99,
        price: '$200',
        buyerCurrencyCode: 'USD',
      },
    ],
    '2026-03-19T12:05:00.000Z',
  );

  const diff = diffSnapshots(previous, current, { minTicketDelta: 1 });

  assert.equal(diff.comparisonMode, 'listing');
  assert.equal(diff.baselineReset, true);
  assert.equal(diff.changeCount, 0);
});
