# Local Setup

## 1. Install dependencies

```bash
npm install
```

## 2. Configure environment variables

Create a `.env` file in the repository root.

Minimum required configuration:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
FEISHU_BOT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/your-webhook-token
```

For Railway or any other trusted server-side runtime, prefer `SUPABASE_SERVICE_ROLE_KEY`.
If you insist on `SUPABASE_ANON_KEY`, you must also configure table grants / RLS policies that allow this monitor to read and write its tables.

Recommended inventory monitor configuration:

```env
MONITOR_MODE=inventory
ALERT_ON_STOCK_APPEAR=true
ALERT_ON_STOCK_DROP=true
ALERT_ON_PRICE_CHANGE=false
MIN_TICKET_DELTA=1
MAX_DIFF_ITEMS_IN_ALERT=10
```

Direct URL mode example:

```env
EVENT_URLS=https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2
```

## 3. Apply the Supabase schema

Run [`docs/supabase-schema.sql`](./docs/supabase-schema.sql) in your Supabase SQL editor.

## 4. Run tests

```bash
npm test
```

## 5. Start the monitor

Database mode:

```bash
npm start
```

Direct URL mode:

```bash
node index.js --url "https://www.viagogo.com/Concert-Tickets/Rock/E-159436715?quantity=2"
```

## Troubleshooting

- `Missing required environment variables`: verify `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- `index-data intercept timeout`: the page loaded but the HTML response with `#index-data` was not captured within the configured timeout
- `Missing venueConfiguration or rowPopupData`: the intercepted JSON branch drifted, or the event page uses a new payload shape
- Feishu webhook configuration failures do not block the scraping run; alerts are skipped and the run continues
