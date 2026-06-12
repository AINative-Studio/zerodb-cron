# zerodb-cron

Cron scheduler + DB event triggers backed by ZeroDB.

## Rules

- This package has ZERO runtime dependencies (built-in cron parser, native fetch)
- ES module (index.js) and CommonJS (index.cjs) entry points
- schedule() matches node-cron's API signature exactly
- onEvent() is the upgrade — DB event triggers that node-cron cannot do
- Auto-provisioning uses POST /api/v1/public/instant-db
- Hooks registered via POST /api/v1/zerodb/hooks
- Events polled via GET /v1/zerodb/{projectId}/events
- Never store credentials in code or tests
- Tests use mocked fetch and fake timers — no real API calls in CI
- Cron parser supports 5-field (minute) and 6-field (second) expressions
