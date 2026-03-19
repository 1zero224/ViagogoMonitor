const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildListingResponseSummary,
  isEventListingJsonResponse,
  shouldReplaceListingBatch,
} = require('../src/scraper');

test('isEventListingJsonResponse only accepts same-origin fetch/xhr JSON responses for the event path', () => {
  const targetUrl = 'https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?quantity=1';

  assert.equal(
    isEventListingJsonResponse(
      'https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?quantity=1&currentPage=2',
      targetUrl,
      'application/json; charset=utf-8',
      'fetch',
    ),
    true,
  );

  assert.equal(
    isEventListingJsonResponse(
      'https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?quantity=2&currentPage=2',
      targetUrl,
      'application/json; charset=utf-8',
      'fetch',
    ),
    false,
  );

  assert.equal(
    isEventListingJsonResponse(
      'https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?quantity=1&currentPage=2',
      targetUrl,
      'application/json; charset=utf-8',
      'document',
    ),
    false,
  );
});

test('buildListingResponseSummary keeps page diagnostics needed for snapshot meta', () => {
  const summary = buildListingResponseSummary(
    'https://www.viagogo.com/Concert-Tickets/Other-Concerts/ZUTOMAYO-Tickets/E-159991465?quantity=1&currentPage=3',
    {
      currentPage: 3,
      totalCount: 39,
      items: [
        {
          id: 12031855619,
        },
      ],
    },
  );

  assert.equal(summary.currentPage, 3);
  assert.equal(summary.totalCount, 39);
  assert.equal(summary.itemCount, 1);
  assert.equal(summary.firstListingId, 12031855619);
  assert.equal(summary.query.quantity, '1');
});

test('shouldReplaceListingBatch prefers the more complete batch for the same page', () => {
  const existing = {
    currentPage: 2,
    itemCount: 12,
    totalCount: 38,
    observedAt: '2026-03-19T18:40:00.000Z',
  };
  const candidate = {
    currentPage: 2,
    itemCount: 13,
    totalCount: 39,
    observedAt: '2026-03-19T18:40:01.000Z',
  };

  assert.equal(shouldReplaceListingBatch(existing, candidate), true);
  assert.equal(shouldReplaceListingBatch(candidate, existing), false);
});
