const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFeishuMessagePayload, buildInventoryMessageText, initializeFeishuNotifier } = require('../src/notify');

function buildPayload() {
  return {
    snapshot: {
      eventUrl: 'https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2',
      capturedAt: '2026-03-19T12:05:00.000Z',
      event: {
        name: 'Artist Name - London',
        date: '2026-08-01',
        location: 'London, UK',
      },
      summary: {
        rowsWithStock: 3,
        sectionsWithStock: 2,
        totalListingCount: 5,
        totalTicketCount: 8,
        minPrice: 199,
        currency: 'GBP',
      },
    },
    diff: {
      changeCount: 2,
      comparisonMode: 'listing',
      summaryChanges: {
        rowsWithStockDelta: 1,
        sectionsWithStockDelta: 1,
        totalListingCountDelta: 2,
        totalTicketCountDelta: 4,
        minPriceDelta: -20,
      },
      changes: [
        {
          type: 'new_listing_available',
          sectionName: 'M15',
          rowId: 'A',
          seat: '1-2',
          listingId: '9001',
          newTicketCount: 2,
          newPrice: 199,
        },
        {
          type: 'listing_ticket_count_increased',
          sectionName: 'M16',
          rowId: 'B',
          seat: '3-4',
          listingId: '9002',
          oldTicketCount: 2,
          newTicketCount: 6,
        },
      ],
    },
    config: {
      maxDiffItemsInAlert: 10,
    },
  };
}

test('buildInventoryMessageText builds a grouped Feishu-friendly plain text message', () => {
  const text = buildInventoryMessageText(buildPayload());

  assert.match(text, /Viagogo Inventory Alert/);
  assert.match(text, /Artist Name - London/);
  assert.match(text, /Alertable changes: 2/);
  assert.match(text, /Comparison mode: listing/);
  assert.match(text, /Total listings: 5 \(\+2\)/);
  assert.match(text, /Top Inventory Changes:/);
  assert.match(text, /New listing available: M15 \/ Row A \/ Seat 1-2 \/ Listing 9001/);
});

test('buildFeishuMessagePayload wraps the text in the expected webhook contract', () => {
  const payload = buildFeishuMessagePayload(buildPayload());

  assert.equal(payload.msg_type, 'text');
  assert.equal(typeof payload.content.text, 'string');
  assert.match(payload.content.text, /Event URL:/);
});

test('initializeFeishuNotifier returns null webhook when config is absent', () => {
  const notifier = initializeFeishuNotifier({});
  assert.equal(notifier.webhookUrl, null);
});

test('initializeFeishuNotifier validates the webhook URL', () => {
  assert.throws(
    () => initializeFeishuNotifier({ feishuBotWebhookUrl: 'not-a-url' }),
    /Invalid FEISHU_BOT_WEBHOOK_URL/,
  );

  const notifier = initializeFeishuNotifier({
    feishuBotWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc123',
  });
  assert.equal(notifier.webhookUrl, 'https://open.feishu.cn/open-apis/bot/v2/hook/abc123');
});
