# zerodb-cron

**Cron scheduler + DB event triggers backed by ZeroDB.** Same `schedule()` syntax as node-cron, plus `onEvent()` for real-time database triggers that node-cron can never do.

[![npm](https://img.shields.io/npm/v/zerodb-cron)](https://www.npmjs.com/package/zerodb-cron)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why switch?

| Feature | node-cron | zerodb-cron |
|---------|-----------|-------------|
| Cron scheduling | Yes | Yes |
| DB event triggers | No | Yes (onEvent) |
| Persistent across restarts | No | Yes (ZeroDB hooks) |
| Auto-provisioning | N/A | Yes (zero config) |
| Zero dependencies | No (3 deps) | Yes |

## Quick Start

```bash
npm install zerodb-cron
```

```javascript
import { schedule, onEvent } from 'zerodb-cron';

// Classic cron syntax — identical to node-cron
schedule('*/5 * * * *', async () => {
  console.log('Runs every 5 minutes');
});

// DB event triggers — the upgrade over node-cron
onEvent('zerodb.vector.stored', async (event) => {
  console.log('New vector stored:', event.data.vector_id);
});

onEvent('zerodb.memory.created', async (event) => {
  console.log('New memory:', event.data);
});
```

## Migration from node-cron

```diff
- import cron from 'node-cron';
+ import { schedule, validate } from 'zerodb-cron';

// Same API — just import from zerodb-cron instead
- cron.schedule('0 * * * *', () => {
+ schedule('0 * * * *', () => {
    console.log('Runs every hour');
  });

- cron.validate('bad expression');
+ validate('bad expression'); // false
```

## Cron Scheduling

```javascript
import { schedule } from 'zerodb-cron';

// Every 5 minutes
const task = schedule('*/5 * * * *', async () => {
  console.log('tick');
});

// With seconds (6-field expression)
schedule('*/30 * * * * *', async () => {
  console.log('Every 30 seconds');
});

// Weekdays only, 9 AM to 5 PM
schedule('0 9-17 * * 1-5', async () => {
  console.log('Business hours check');
});

// Control the task
task.stop();   // Pause
task.start();  // Resume
task.destroy(); // Clean up
```

## DB Event Triggers

The killer feature node-cron doesn't have:

```javascript
import { onEvent } from 'zerodb-cron';

// React to vector operations
onEvent('zerodb.vector.stored', async (event) => {
  console.log('Vector stored:', event.data);
});

// React to memory events
onEvent('zerodb.memory.created', async (event) => {
  console.log('Memory created:', event.data);
});

// React to file uploads
onEvent('zerodb.file.uploaded', async (event) => {
  console.log('File uploaded:', event.data.file_name);
});

// Custom poll interval (default: 5 seconds)
const listener = onEvent('zerodb.table.row_inserted', async (event) => {
  console.log('New row:', event.data);
}, { pollInterval: 2000 });

// Stop listening
listener.stop();
```

## Combined: Cron + Events

```javascript
import { schedule, onEvent } from 'zerodb-cron';

// Hourly: process all vectors stored in the last hour
schedule('0 * * * *', async () => {
  console.log('Hourly vector processing batch');
});

// Real-time: react to new vectors immediately
onEvent('zerodb.vector.stored', async (event) => {
  console.log('Immediate: new vector', event.data.vector_id);
});
```

## Validation

```javascript
import { validate } from 'zerodb-cron';

validate('*/5 * * * *');     // true
validate('0 9-17 * * 1-5');  // true
validate('bad expression');   // false
validate('* * *');            // false (too few fields)
```

## Configuration

```javascript
import { configure } from 'zerodb-cron';

// Option 1: Environment variables (recommended)
// ZERODB_API_KEY=your-key
// ZERODB_PROJECT_ID=your-project

// Option 2: Explicit config
configure({
  apiKey: 'your-key',
  projectId: 'your-project',
});

// Option 3: Auto-provisioning (just use it, ZeroDB provisions automatically)
```

## Options

### schedule(expression, callback, options?)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scheduled` | boolean | `true` | Start immediately |
| `timezone` | string | `null` | IANA timezone name |
| `name` | string | auto | Task name for hook registration |

### onEvent(eventType, callback, options?)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pollInterval` | number | `5000` | Poll interval in ms |
| `name` | string | auto | Hook name |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ZERODB_API_KEY` | ZeroDB API key |
| `ZERODB_PROJECT_ID` | ZeroDB project ID |

---

> **Built by [AINative Studio](https://ainative.studio)** | [ZeroDB Docs](https://zerodb.ai) | [GitHub](https://github.com/AINative-Studio/zerodb-cron)
>
> Drop-in node-cron replacement. Get DB event triggers for free.
> ```bash
> npm install zerodb-cron
> ```

---

## Zero-Config Auto-Provisioning

**No account needed to start.** On first run, this package automatically:

1. Provisions a **free ZeroDB instance** (~800ms)
2. Saves credentials locally (`.env`, `.mcp.json`)
3. Prints a **claim link** in your terminal

### The 72-Hour Window

Your auto-provisioned instance is **free for 72 hours**. To keep your data permanently, visit the **claim URL** printed in your terminal.

### For AI Agents

If a coding agent (Claude Code, Cursor, Windsurf) installs this package:
- Auto-provisions without human intervention
- The **claim URL** appears in agent output — visit it to take ownership
- `.claude/CLAUDE.md` instructs agents to surface the claim link to you
- Check `.env` or `~/.ainative/config.json` for your project ID if you miss it
