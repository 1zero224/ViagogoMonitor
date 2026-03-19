#!/bin/sh
set -eu

echo "[entrypoint] Viagogo Inventory Monitor container starting"
echo "[entrypoint] node=$(node -v)"
echo "[entrypoint] Xvfb=$(command -v Xvfb || true)"
echo "[entrypoint] chromium=$(command -v chromium || true)"
echo "[entrypoint] RAILWAY_PROJECT_NAME=${RAILWAY_PROJECT_NAME:-missing}"
echo "[entrypoint] RAILWAY_ENVIRONMENT_NAME=${RAILWAY_ENVIRONMENT_NAME:-missing}"
echo "[entrypoint] RAILWAY_SERVICE_NAME=${RAILWAY_SERVICE_NAME:-missing}"
echo "[entrypoint] RAILWAY_DEPLOYMENT_ID=${RAILWAY_DEPLOYMENT_ID:-missing}"

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

DISPLAY_NUM="${DISPLAY:-:99}"
XVFB_LOG_PATH="/tmp/xvfb.log"

echo "[entrypoint] starting Xvfb on ${DISPLAY_NUM}"
Xvfb "${DISPLAY_NUM}" -screen 0 1920x1080x24 -ac +extension RANDR >"${XVFB_LOG_PATH}" 2>&1 &
XVFB_PID=$!

cleanup() {
  if kill -0 "${XVFB_PID}" 2>/dev/null; then
    kill "${XVFB_PID}" 2>/dev/null || true
    wait "${XVFB_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

sleep 1
if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
  echo "[entrypoint] Xvfb failed to start"
  if [ -f "${XVFB_LOG_PATH}" ]; then
    cat "${XVFB_LOG_PATH}"
  fi
  exit 1
fi

export DISPLAY="${DISPLAY_NUM}"
echo "[entrypoint] DISPLAY=${DISPLAY}"
echo "[entrypoint] launching node index.js"
node index.js
