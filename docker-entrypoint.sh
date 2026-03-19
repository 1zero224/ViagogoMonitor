#!/bin/sh
set -eu

echo "[entrypoint] Viagogo Inventory Monitor container starting"
echo "[entrypoint] node=$(node -v)"
echo "[entrypoint] xvfb-run=$(command -v xvfb-run)"
echo "[entrypoint] chromium=$(command -v chromium || true)"

if [ -n "${SUPABASE_URL:-}" ]; then
  echo "[entrypoint] SUPABASE_URL=set"
else
  echo "[entrypoint] SUPABASE_URL=missing"
fi

if [ -n "${SUPABASE_ANON_KEY:-}" ]; then
  echo "[entrypoint] SUPABASE_ANON_KEY=set"
else
  echo "[entrypoint] SUPABASE_ANON_KEY=missing"
fi

if [ -n "${FEISHU_BOT_WEBHOOK_URL:-${FEISHU_WEBHOOK_URL:-}}" ]; then
  echo "[entrypoint] FEISHU_WEBHOOK=set"
else
  echo "[entrypoint] FEISHU_WEBHOOK=missing"
fi

if [ -n "${EVENT_URLS:-}" ]; then
  echo "[entrypoint] EVENT_URLS=set"
else
  echo "[entrypoint] EVENT_URLS=empty"
fi

exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" node index.js
