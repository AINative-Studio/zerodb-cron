/**
 * zerodb-cron — CommonJS entry point.
 *
 * Cron scheduler + DB event triggers backed by ZeroDB.
 * Zero config: auto-provisions on first use.
 *
 * Refs #4018
 */

'use strict';

const ZERODB_API_BASE = 'https://api.ainative.studio';
const INSTANT_DB_ENDPOINT = `${ZERODB_API_BASE}/api/v1/public/instant-db`;
const HOOKS_ENDPOINT = `${ZERODB_API_BASE}/api/v1/zerodb/hooks`;
const EVENTS_ENDPOINT = (projectId) =>
  `${ZERODB_API_BASE}/v1/zerodb/${projectId}/events`;

// ---------------------------------------------------------------------------
// Cron expression parser
// ---------------------------------------------------------------------------

const FIELD_RANGES = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 6, name: 'weekday' },
];

const SECOND_FIELD = { min: 0, max: 59, name: 'second' };

function parseCronField(field, range) {
  if (field === '*') return null;

  const values = new Set();

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [rangePart, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      let start = range.min;
      let end = range.max;
      if (rangePart !== '*') {
        if (rangePart.includes('-')) {
          [start, end] = rangePart.split('-').map(Number);
        } else {
          start = parseInt(rangePart, 10);
        }
      }
      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return values;
}

function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);

  let hasSeconds = false;
  let parts;

  if (fields.length === 6) {
    hasSeconds = true;
    parts = fields;
  } else if (fields.length === 5) {
    parts = fields;
  } else {
    throw new Error(`Invalid cron expression: "${expression}" (expected 5 or 6 fields)`);
  }

  const offset = hasSeconds ? 1 : 0;

  return {
    second: hasSeconds ? parseCronField(parts[0], SECOND_FIELD) : new Set([0]),
    minute: parseCronField(parts[0 + offset], FIELD_RANGES[0]),
    hour: parseCronField(parts[1 + offset], FIELD_RANGES[1]),
    day: parseCronField(parts[2 + offset], FIELD_RANGES[2]),
    month: parseCronField(parts[3 + offset], FIELD_RANGES[3]),
    weekday: parseCronField(parts[4 + offset], FIELD_RANGES[4]),
  };
}

function matchesCron(parsed, date) {
  const checks = [
    { values: parsed.second, actual: date.getSeconds() },
    { values: parsed.minute, actual: date.getMinutes() },
    { values: parsed.hour, actual: date.getHours() },
    { values: parsed.day, actual: date.getDate() },
    { values: parsed.month, actual: date.getMonth() + 1 },
    { values: parsed.weekday, actual: date.getDay() },
  ];

  return checks.every(({ values, actual }) => values === null || values.has(actual));
}

function validate(expression) {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`ZeroDB API error ${res.status}: ${body}`);
    err.statusCode = res.status;
    throw err;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res;
}

async function autoProvision(source) {
  const data = await httpRequest(INSTANT_DB_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: source || 'zerodb-cron' }),
  });

  return {
    projectId: data.project_id,
    apiKey: data.api_key,
    claimUrl: data.claim_url || null,
  };
}

// ---------------------------------------------------------------------------
// Provisioning state
// ---------------------------------------------------------------------------

let _apiKey = process.env.ZERODB_API_KEY || '';
let _projectId = process.env.ZERODB_PROJECT_ID || '';
let _endpoint = process.env.ZERODB_ENDPOINT || ZERODB_API_BASE;
let _provisioned = false;
let _provisionPromise = null;

async function ensureProvisioned() {
  if (_apiKey && _projectId) return;

  if (_provisionPromise) {
    await _provisionPromise;
    return;
  }

  _provisionPromise = (async () => {
    const result = await autoProvision('zerodb-cron');
    _projectId = result.projectId;
    _apiKey = result.apiKey;
    _provisioned = true;

    if (result.claimUrl) {
      console.log(`\n  ZeroDB auto-provisioned (free, 72h trial).`);
      console.log(`  Claim to keep permanently: ${result.claimUrl}\n`);
    }
  })();

  await _provisionPromise;
}

function _resetState() {
  _apiKey = process.env.ZERODB_API_KEY || '';
  _projectId = process.env.ZERODB_PROJECT_ID || '';
  _provisioned = false;
  _provisionPromise = null;
}

function _getState() {
  return { apiKey: _apiKey, projectId: _projectId, provisioned: _provisioned };
}

// ---------------------------------------------------------------------------
// ScheduledTask
// ---------------------------------------------------------------------------

class ScheduledTask {
  constructor(expression, callback, opts = {}) {
    this.expression = expression;
    this.callback = callback;
    this.name = opts.name || `cron_${expression.replace(/\s+/g, '_')}`;
    this.timezone = opts.timezone || null;
    this.scheduled = opts.scheduled !== false;
    this.running = false;
    this._interval = null;
    this._parsed = parseCron(expression);
    this._lastRun = null;
    this._hookRegistered = false;

    if (this.scheduled) {
      this.start();
    }
  }

  start() {
    if (this._interval) return;

    this.running = true;
    const hasSeconds = this.expression.trim().split(/\s+/).length === 6;
    const checkInterval = hasSeconds ? 1000 : 60000;

    const self = this;
    this._interval = setInterval(() => {
      const now = new Date();

      if (self._lastRun) {
        const diff = now.getTime() - self._lastRun.getTime();
        if (diff < checkInterval) return;
      }

      if (matchesCron(self._parsed, now)) {
        self._lastRun = now;
        try {
          const result = self.callback(now);
          if (result && typeof result.catch === 'function') {
            result.catch((err) => {
              console.error(`Cron task "${self.name}" error:`, err);
            });
          }
        } catch (err) {
          console.error(`Cron task "${self.name}" error:`, err);
        }
      }
    }, checkInterval);

    this._registerHook();
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.running = false;
  }

  destroy() {
    this.stop();
  }

  async _registerHook() {
    if (this._hookRegistered) return;
    try {
      await ensureProvisioned();
      await httpRequest(HOOKS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': _apiKey,
        },
        body: JSON.stringify({
          event_type: 'zerodb.cron.tick',
          hook_name: this.name,
          project_id: _projectId,
          hook_config: {
            cron_expression: this.expression,
            timezone: this.timezone,
          },
        }),
      });
      this._hookRegistered = true;
    } catch (err) {
      if (err.statusCode !== 409) {
        // Silent
      }
      this._hookRegistered = true;
    }
  }
}

// ---------------------------------------------------------------------------
// EventListener
// ---------------------------------------------------------------------------

class EventListener {
  constructor(eventType, callback, opts = {}) {
    this.eventType = eventType;
    this.callback = callback;
    this.name = opts.name || `event_${eventType.replace(/\./g, '_')}`;
    this.pollInterval = opts.pollInterval || 5000;
    this.running = false;
    this._interval = null;
    this._lastEventId = null;
    this._hookRegistered = false;

    this.start();
  }

  start() {
    if (this._interval) return;
    this.running = true;

    this._registerHook();

    const self = this;
    this._interval = setInterval(async () => {
      try {
        await self._pollEvents();
      } catch (err) {
        // Silent
      }
    }, this.pollInterval);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.running = false;
  }

  destroy() {
    this.stop();
  }

  async _pollEvents() {
    await ensureProvisioned();

    const url = EVENTS_ENDPOINT(_projectId);
    const params = new URLSearchParams({
      event_type: this.eventType,
      limit: '50',
    });
    if (this._lastEventId) {
      params.set('after', this._lastEventId);
    }

    const events = await httpRequest(`${url}?${params}`, {
      headers: { 'X-API-Key': _apiKey },
    });

    if (Array.isArray(events) && events.length > 0) {
      for (const event of events) {
        this._lastEventId = event.id || event.event_id;
        try {
          await this.callback(event);
        } catch (err) {
          console.error(`Event handler "${this.name}" error:`, err);
        }
      }
    }
  }

  async _registerHook() {
    if (this._hookRegistered) return;
    try {
      await ensureProvisioned();
      await httpRequest(HOOKS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': _apiKey,
        },
        body: JSON.stringify({
          event_type: this.eventType,
          hook_name: this.name,
          project_id: _projectId,
          hook_config: { poll_interval: this.pollInterval },
        }),
      });
      this._hookRegistered = true;
    } catch (err) {
      if (err.statusCode !== 409) {
        // Silent
      }
      this._hookRegistered = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function schedule(expression, callback, opts = {}) {
  return new ScheduledTask(expression, callback, opts);
}

function onEvent(eventType, callback, opts = {}) {
  return new EventListener(eventType, callback, opts);
}

function configure(opts = {}) {
  if (opts.apiKey) _apiKey = opts.apiKey;
  if (opts.projectId) _projectId = opts.projectId;
  if (opts.endpoint) _endpoint = opts.endpoint;
}

module.exports = {
  schedule,
  onEvent,
  validate,
  configure,
  ScheduledTask,
  EventListener,
  _resetState,
  _getState,
  default: { schedule, onEvent, validate, configure },
};
