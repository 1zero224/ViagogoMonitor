const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAlertDiff, buildDebouncedListingAvailabilityChanges } = require('../src/alerting');
const { buildInventorySnapshot } = require('../src/normalize');

function buildSnapshot(listingIds, capturedAt) {
  return buildInventorySnapshot({
    eventUrl: 'https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?quantity=1',
    eventId: '159991465',
    capturedAt,
    eventDetails: {
      name: 'ZUTOMAYO Tickets',
    },
    sections: [],
    listingItems: listingIds.map((listingId) => ({
      id: listingId,
      sectionId: 724529,
      sectionMapName: 'B',
      row: 'BJ',
      seat: '16_16',
      availableTickets: 1,
      rawPrice: 372.63,
      price: '$373',
      buyerCurrencyCode: 'USD',
    })),
  });
}

test('buildDebouncedListingAvailabilityChanges confirms a listing addition only after two present observations', () => {
  const currentSnapshot = buildSnapshot(['12031855619'], '2026-03-19T19:10:58.615Z');
  const previousSnapshot = buildSnapshot(['12031855619'], '2026-03-19T19:01:11.888Z');
  const anchorSnapshot = buildSnapshot([], '2026-03-19T18:50:53.225Z');

  const changes = buildDebouncedListingAvailabilityChanges({
    currentSnapshot,
    previousSnapshots: [previousSnapshot, anchorSnapshot],
    confirmRuns: 2,
  });

  assert.deepEqual(
    changes.map((change) => ({ type: change.type, listingId: change.listingId, newTicketCount: change.newTicketCount })),
    [
      {
        type: 'new_listing_available',
        listingId: '12031855619',
        newTicketCount: 1,
      },
    ],
  );
});

test('buildDebouncedListingAvailabilityChanges confirms a listing removal only after two absent observations', () => {
  const currentSnapshot = buildSnapshot([], '2026-03-19T19:31:08.592Z');
  const previousSnapshot = buildSnapshot([], '2026-03-19T19:20:35.465Z');
  const anchorSnapshot = buildSnapshot(['12031855619'], '2026-03-19T19:10:58.615Z');

  const changes = buildDebouncedListingAvailabilityChanges({
    currentSnapshot,
    previousSnapshots: [previousSnapshot, anchorSnapshot],
    confirmRuns: 2,
  });

  assert.deepEqual(
    changes.map((change) => ({ type: change.type, listingId: change.listingId, oldTicketCount: change.oldTicketCount })),
    [
      {
        type: 'listing_removed',
        listingId: '12031855619',
        oldTicketCount: 1,
      },
    ],
  );
});

test('buildAlertDiff suppresses raw listing availability flips and emits only confirmed availability changes', () => {
  const currentSnapshot = buildSnapshot([], '2026-03-19T19:31:08.592Z');
  const previousSnapshot = buildSnapshot([], '2026-03-19T19:20:35.465Z');
  const anchorSnapshot = buildSnapshot(['12031855619'], '2026-03-19T19:10:58.615Z');
  const diff = {
    comparisonMode: 'listing',
    changeCount: 1,
    changes: [
      {
        type: 'listing_removed',
        entityType: 'listing',
        listingId: '12031855619',
        sectionName: 'B',
        rowId: 'BJ',
        seat: '16_16',
        oldTicketCount: 1,
        newTicketCount: null,
      },
    ],
  };

  const alertDiff = buildAlertDiff({
    diff,
    currentSnapshot,
    previousSnapshots: [previousSnapshot, anchorSnapshot],
    config: {
      debounceListingAvailabilityAlerts: true,
      listingAvailabilityConfirmRuns: 2,
    },
  });

  assert.equal(alertDiff.debounce.enabled, true);
  assert.equal(alertDiff.debounce.suppressedRawAvailabilityChangeCount, 1);
  assert.equal(alertDiff.debounce.emittedDebouncedAvailabilityChangeCount, 1);
  assert.deepEqual(
    alertDiff.changes.map((change) => `${change.type}:${change.listingId}`),
    ['listing_removed:12031855619'],
  );
});
