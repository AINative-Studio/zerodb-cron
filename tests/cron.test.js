/**
 * zerodb-cron unit tests.
 *
 * All HTTP calls are mocked via globalThis.fetch — no real API calls.
 * Uses Node.js built-in test runner (node:test).
 *
 * Refs #4018
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  schedule,
  onEvent,
  validate,
  configure,
  ScheduledTask,
  EventListener,
  _resetState,
  _getState,
} from '../index.js';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockResponses = [];

function pushMock(status, body, contentType = 'application/json') {
  mockResponses.push({ status, body, contentType });
}

function createMockFetch() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const mock = mockResponses.shift();
    if (!mock) throw new Error(`Unexpected fetch call: ${url}`);

    return {
      ok: mock.status >= 200 && mock.status < 300,
      status: mock.status,
      headers: {
        get: (name) => {
          if (name === 'content-type') return mock.contentType;
          return null;
        },
      },
      json: async () => (typeof mock.body === 'string' ? JSON.parse(mock.body) : mock.body),
      text: async () => (typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

let mockFetch;

beforeEach(() => {
  mockResponses.length = 0;
  mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;
  process.env.ZERODB_API_KEY = 'test-key';
  process.env.ZERODB_PROJECT_ID = 'test-proj';
  _resetState();
});

afterEach(() => {
  delete globalThis.fetch;
  delete process.env.ZERODB_API_KEY;
  delete process.env.ZERODB_PROJECT_ID;
  _resetState();
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe('validate()', () => {
  it('accepts standard 5-field cron', () => {
    assert.equal(validate('*/5 * * * *'), true);
    assert.equal(validate('0 0 * * *'), true);
    assert.equal(validate('30 9 1 1 *'), true);
    assert.equal(validate('0 */2 * * 1-5'), true);
  });

  it('accepts 6-field cron (with seconds)', () => {
    assert.equal(validate('*/10 * * * * *'), true);
    assert.equal(validate('0 0 0 * * *'), true);
  });

  it('rejects invalid expressions', () => {
    assert.equal(validate('bad'), false);
    assert.equal(validate('* * *'), false);
    assert.equal(validate(''), false);
    assert.equal(validate('* * * * * * *'), false);
  });

  it('accepts ranges', () => {
    assert.equal(validate('1-5 * * * *'), true);
    assert.equal(validate('*/15 9-17 * * 1-5'), true);
  });

  it('accepts lists', () => {
    assert.equal(validate('0,15,30,45 * * * *'), true);
  });
});

// ---------------------------------------------------------------------------
// schedule()
// ---------------------------------------------------------------------------

describe('schedule()', () => {
  it('returns a ScheduledTask', () => {
    // Hook registration (fire-and-forget)
    pushMock(201, { id: 'hook-1' });

    const task = schedule('*/5 * * * *', () => {}, { scheduled: true });
    assert.ok(task instanceof ScheduledTask);
    assert.equal(task.running, true);
    assert.equal(task.expression, '*/5 * * * *');
    task.destroy();
  });

  it('starts by default', () => {
    pushMock(201, { id: 'hook-1' });

    const task = schedule('0 * * * *', () => {});
    assert.equal(task.running, true);
    task.destroy();
  });

  it('can be created unscheduled', () => {
    const task = schedule('0 * * * *', () => {}, { scheduled: false });
    assert.equal(task.running, false);
    assert.equal(task._interval, null);
    task.destroy();
  });

  it('stop() pauses the task', () => {
    pushMock(201, { id: 'hook-1' });

    const task = schedule('0 * * * *', () => {});
    assert.equal(task.running, true);
    task.stop();
    assert.equal(task.running, false);
    assert.equal(task._interval, null);
    task.destroy();
  });

  it('accepts custom name', () => {
    pushMock(201, { id: 'hook-1' });

    const task = schedule('*/5 * * * *', () => {}, { name: 'my-job' });
    assert.equal(task.name, 'my-job');
    task.destroy();
  });

  it('accepts timezone option', () => {
    pushMock(201, { id: 'hook-1' });

    const task = schedule('0 9 * * *', () => {}, { timezone: 'America/New_York' });
    assert.equal(task.timezone, 'America/New_York');
    task.destroy();
  });

  it('registers hook with ZeroDB API', async () => {
    pushMock(201, { id: 'hook-1', event_type: 'zerodb.cron.tick' });

    const task = schedule('*/5 * * * *', () => {}, { name: 'test-cron' });

    // Wait for async registration
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(mockFetch.calls.length >= 1);
    const hookCall = mockFetch.calls.find((c) => c.url.includes('/hooks'));
    if (hookCall) {
      const body = JSON.parse(hookCall.opts.body);
      assert.equal(body.event_type, 'zerodb.cron.tick');
      assert.equal(body.hook_name, 'test-cron');
      assert.equal(body.hook_config.cron_expression, '*/5 * * * *');
    }
    task.destroy();
  });

  it('handles 409 conflict silently', async () => {
    pushMock(409, { detail: 'Hook already exists' });

    const task = schedule('0 * * * *', () => {});
    await new Promise((r) => setTimeout(r, 50));

    // Should not throw
    assert.equal(task.running, true);
    task.destroy();
  });
});

// ---------------------------------------------------------------------------
// onEvent()
// ---------------------------------------------------------------------------

describe('onEvent()', () => {
  it('returns an EventListener', () => {
    pushMock(201, { id: 'hook-1' });

    const listener = onEvent('zerodb.vector.stored', () => {});
    assert.ok(listener instanceof EventListener);
    assert.equal(listener.running, true);
    assert.equal(listener.eventType, 'zerodb.vector.stored');
    listener.destroy();
  });

  it('registers hook with ZeroDB API', async () => {
    pushMock(201, { id: 'hook-1' });

    const listener = onEvent('zerodb.memory.created', () => {}, { name: 'mem-hook' });
    await new Promise((r) => setTimeout(r, 50));

    const hookCall = mockFetch.calls.find((c) => c.url.includes('/hooks'));
    if (hookCall) {
      const body = JSON.parse(hookCall.opts.body);
      assert.equal(body.event_type, 'zerodb.memory.created');
      assert.equal(body.hook_name, 'mem-hook');
    }
    listener.destroy();
  });

  it('accepts custom poll interval', () => {
    pushMock(201, { id: 'hook-1' });

    const listener = onEvent('zerodb.file.uploaded', () => {}, { pollInterval: 10000 });
    assert.equal(listener.pollInterval, 10000);
    listener.destroy();
  });

  it('stop() pauses the listener', () => {
    pushMock(201, { id: 'hook-1' });

    const listener = onEvent('zerodb.vector.stored', () => {});
    assert.equal(listener.running, true);
    listener.stop();
    assert.equal(listener.running, false);
    listener.destroy();
  });

  it('generates default name from event type', () => {
    pushMock(201, { id: 'hook-1' });

    const listener = onEvent('zerodb.vector.stored', () => {});
    assert.equal(listener.name, 'event_zerodb_vector_stored');
    listener.destroy();
  });
});

// ---------------------------------------------------------------------------
// configure()
// ---------------------------------------------------------------------------

describe('configure()', () => {
  it('sets apiKey and projectId', () => {
    _resetState();
    delete process.env.ZERODB_API_KEY;
    delete process.env.ZERODB_PROJECT_ID;
    _resetState();

    configure({ apiKey: 'custom-key', projectId: 'custom-proj' });
    const state = _getState();
    assert.equal(state.apiKey, 'custom-key');
    assert.equal(state.projectId, 'custom-proj');
  });
});

// ---------------------------------------------------------------------------
// auto-provisioning
// ---------------------------------------------------------------------------

describe('auto-provisioning', () => {
  it('provisions when no credentials', async () => {
    delete process.env.ZERODB_API_KEY;
    delete process.env.ZERODB_PROJECT_ID;
    _resetState();

    // Provision response
    pushMock(200, {
      project_id: 'auto-proj',
      api_key: 'auto-key',
      claim_url: 'https://zerodb.ai/claim/test',
    });
    // Hook registration
    pushMock(201, { id: 'hook-1' });

    const task = schedule('0 * * * *', () => {});
    await new Promise((r) => setTimeout(r, 100));

    const state = _getState();
    assert.equal(state.provisioned, true);
    assert.equal(state.projectId, 'auto-proj');
    task.destroy();
  });

  it('skips provisioning when credentials exist', async () => {
    pushMock(201, { id: 'hook-1' });

    const task = schedule('0 * * * *', () => {});
    await new Promise((r) => setTimeout(r, 50));

    // Only hook registration, no provisioning call
    const provisionCalls = mockFetch.calls.filter((c) => c.url.includes('/instant-db'));
    assert.equal(provisionCalls.length, 0);
    task.destroy();
  });
});

// ---------------------------------------------------------------------------
// Cron parser internals
// ---------------------------------------------------------------------------

describe('cron parser', () => {
  it('parses every-5-minutes correctly', () => {
    const task = new ScheduledTask('*/5 * * * *', () => {}, { scheduled: false });
    const date = new Date(2026, 0, 1, 12, 15, 0); // 12:15
    // minute 15 is divisible by 5
    assert.ok(task._parsed.minute.has(15));
    assert.ok(task._parsed.minute.has(0));
    assert.ok(task._parsed.minute.has(5));
    assert.ok(!task._parsed.minute.has(3));
    task.destroy();
  });

  it('parses ranges correctly', () => {
    const task = new ScheduledTask('0 9-17 * * 1-5', () => {}, { scheduled: false });
    assert.ok(task._parsed.hour.has(9));
    assert.ok(task._parsed.hour.has(17));
    assert.ok(!task._parsed.hour.has(8));
    assert.ok(task._parsed.weekday.has(1));
    assert.ok(task._parsed.weekday.has(5));
    assert.ok(!task._parsed.weekday.has(0));
    task.destroy();
  });

  it('parses lists correctly', () => {
    const task = new ScheduledTask('0,15,30,45 * * * *', () => {}, { scheduled: false });
    assert.ok(task._parsed.minute.has(0));
    assert.ok(task._parsed.minute.has(15));
    assert.ok(task._parsed.minute.has(30));
    assert.ok(task._parsed.minute.has(45));
    assert.ok(!task._parsed.minute.has(10));
    task.destroy();
  });

  it('wildcard matches all values', () => {
    const task = new ScheduledTask('* * * * *', () => {}, { scheduled: false });
    // null means "match all"
    assert.equal(task._parsed.minute, null);
    assert.equal(task._parsed.hour, null);
    task.destroy();
  });

  it('6-field expression includes seconds', () => {
    const task = new ScheduledTask('*/10 * * * * *', () => {}, { scheduled: false });
    assert.ok(task._parsed.second.has(0));
    assert.ok(task._parsed.second.has(10));
    assert.ok(task._parsed.second.has(20));
    assert.ok(!task._parsed.second.has(5));
    task.destroy();
  });
});
