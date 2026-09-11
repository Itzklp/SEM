// Loaded via `-r ./tracing-preload.js`, AFTER `./preload.js` (dotenv) and
// BEFORE `tsconfig-paths/register` — see package.json's `dev`/`start`
// scripts and packages/observability/preload-tracing.js's doc comment
// for why this has to run this early. `event-worker` has no HTTP server
// of its own today, but DOES make outbound calls (Postgres, Redis,
// Kafka) and will make outbound HTTP calls once Phase 10's `ml-service`
// client exists — same preload, for the same reason, applied uniformly
// rather than only where it was most visibly broken.
require('../../packages/observability/preload-tracing.js').start('event-worker');
