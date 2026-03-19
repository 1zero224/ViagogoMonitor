const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCompatibilitySnapshot, buildInventorySnapshot } = require('../src/normalize');

test('buildInventorySnapshot computes summary metrics from normalized sections', () => {
  const snapshot = buildInventorySnapshot({
    eventUrl: 'https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2',
    eventId: '159436715',
    eventDetails: {
      name: 'Artist Name - London',
      date: '2026-08-01',
      location: 'London, UK',
      imageUrl: 'https://example.com/poster.jpg',
    },
    sections: [
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
        price: null,
        priceFormatted: null,
        ticketCount: 0,
        listingCount: 0,
        rowPopupEntry: null,
        dataNotFound: true,
      },
      {
        sectionId: 56343,
        sectionMapName: 'M16',
        sectionName: 'M16',
        ticketClassId: 300,
        rowId: '1',
        price: 310.5,
        priceFormatted: '£310.50',
        ticketCount: 4,
        listingCount: 2,
        rowPopupEntry: { currencyCode: 'GBP' },
        dataNotFound: false,
      },
    ],
    listingItems: [
      {
        id: 9001,
        sectionId: 56342,
        sectionMapName: 'M15',
        row: 'A',
        rowId: 'A',
        seat: '1-2',
        ticketClass: 267,
        ticketClassName: 'Lower Bowl',
        availableTickets: 2,
        rawPrice: 239.22,
        price: '£239.22',
        buyerCurrencyCode: 'GBP',
      },
      {
        id: 9002,
        sectionId: 56343,
        sectionMapName: 'M16',
        row: '1',
        rowId: '1',
        seat: '5-8',
        ticketClass: 300,
        ticketClassName: 'Upper Bowl',
        availableTickets: 4,
        rawPrice: 310.5,
        price: '£310.50',
        buyerCurrencyCode: 'GBP',
      },
    ],
  });

  assert.equal(snapshot.summary.rowsTracked, 3);
  assert.equal(snapshot.summary.rowsWithStock, 2);
  assert.equal(snapshot.summary.sectionsTracked, 2);
  assert.equal(snapshot.summary.sectionsWithStock, 2);
  assert.equal(snapshot.summary.totalListingCount, 2);
  assert.equal(snapshot.summary.totalTicketCount, 6);
  assert.equal(snapshot.summary.minPrice, 239.22);
  assert.equal(snapshot.summary.currency, 'GBP');
  assert.equal(snapshot.meta.comparisonEntity, 'listing');
  assert.equal(snapshot.listings['9001'].availableTickets, 2);
});

test('buildCompatibilitySnapshot rebuilds a previous snapshot from previousprices cache', () => {
  const snapshot = buildCompatibilitySnapshot({
    eventUrl: 'https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2',
    previousPrices: {
      '267_56342_A': {
        sectionName: 'M15',
        ticketCount: 2,
        rawMinPrice: 239.22,
        formattedMinPrice: '£239.22',
        listingCount: 1,
      },
    },
  });

  assert.equal(snapshot.summary.rowsTracked, 1);
  assert.equal(snapshot.summary.totalListingCount, 1);
  assert.equal(snapshot.rows['267_56342_A'].ticketCount, 2);
  assert.equal(snapshot.rows['267_56342_A'].sectionName, 'M15');
  assert.equal(snapshot.meta.comparisonEntity, 'row');
});
