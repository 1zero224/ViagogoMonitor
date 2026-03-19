const crypto = require('node:crypto');

async function randomDelay(min = 500, max = 1500) {
  const lower = Math.max(0, Math.min(min, max));
  const upper = Math.max(lower, max);
  const duration = Math.floor(Math.random() * (upper - lower + 1)) + lower;
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function stripWrappingQuotes(value) {
  if (value == null) {
    return value;
  }

  const trimmed = String(value).trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue;
  }

  const normalized = stripWrappingQuotes(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseNumber(value, defaultValue) {
  if (value == null || value === '') {
    return defaultValue;
  }

  const parsed = Number(stripWrappingQuotes(value));
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function splitList(value) {
  if (!value) {
    return [];
  }

  return stripWrappingQuotes(value)
    .split(/[\r\n,;]+/)
    .map((item) => stripWrappingQuotes(item))
    .filter(Boolean);
}

function normalizeWhitespace(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return normalizeWhitespace(String(value));
  }

  return date.toISOString().slice(0, 10);
}

function generateRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return crypto
    .createHash('sha1')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
}

function buildEventIdFromUrl(url) {
  const match = String(url || '').match(/\/E-(\d+)(?:$|[?#])/i);
  return match ? match[1] : null;
}

function formatMoney(value, currency) {
  if (value == null || value === '') {
    return 'n/a';
  }

  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return 'n/a';
  }

  return currency ? `${currency} ${amount.toFixed(2)}` : amount.toFixed(2);
}

function truncate(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatSignedNumber(value, digits = 0) {
  if (!Number.isFinite(value)) {
    return '0';
  }

  const formatted = value.toFixed(digits);
  return value > 0 ? `+${formatted}` : formatted;
}

module.exports = {
  buildEventIdFromUrl,
  formatMoney,
  formatSignedNumber,
  generateRunId,
  normalizeWhitespace,
  parseBoolean,
  parseNumber,
  randomDelay,
  splitList,
  stripWrappingQuotes,
  toIsoDate,
  truncate,
};
