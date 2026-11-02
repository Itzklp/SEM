// Loaded via `-r`, after preload.js (dotenv) and before tsconfig-paths/register
// — see preload-tracing.js's doc comment for why this has to run this early.
require('../../packages/observability/preload-tracing.js').start('event-worker');
