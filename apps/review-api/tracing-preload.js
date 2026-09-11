// Loaded via `-r ./tracing-preload.js`, AFTER `./preload.js` (dotenv) and
// BEFORE `tsconfig-paths/register` — see package.json's `dev`/`start`
// scripts and packages/observability/preload-tracing.js's doc comment
// for why this has to run this early.
require('../../packages/observability/preload-tracing.js').start('review-api');
