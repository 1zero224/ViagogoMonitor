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
        totalTicketCount: 8,
        minPrice: 199,
        currency: 'GBP',
      },
    },
    diff: {
      changeCount: 2,
      summaryChanges: {
        rowsWithStockDelta: 1,
        sectionsWithStockDelta: 1,
        totalTicketCountDelta: 4,
        minPriceDelta: -20,
      },
      changes: [
        {
          type: 'stock_appeared',
          sectionName: 'M15',
          rowId: 'A',
          newTicketCount: 2,
          newPrice: 199,
        },
        {
          type: 'ticket_count_increased',
          sectionName: 'M16',
          rowId: 'B',
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
  assert.match(text, /Top Inventory Changes:/);
  assert.match(text, /Stock appeared: M15 \/ Row A/);
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
