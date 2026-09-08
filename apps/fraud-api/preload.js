// Loaded via `node -r ./preload.js` / `ts-node-dev -r ./preload.js` —
// BEFORE src/main.ts is ever required. This is the only way to guarantee
// .env is loaded before packages/config's loadConfig() runs: main.ts's own
// top-level `import` statements (including the whole AppModule ->
// CommonModule -> config.provider chain, which calls loadConfig()
// eagerly) get hoisted above any code written later in that same file by
// TypeScript's CommonJS output, regardless of source order. A plain JS
// preload file outside that import graph has no such hoisting to fight.
const path = require('node:path');
const { config } = require('dotenv');

// Never overrides an already-set process.env value (dotenv default), so a
// container/CI with real env vars injected directly — no .env file present
// at all — is unaffected; this is a local-development convenience only.
config({ path: path.join(__dirname, '..', '..', '.env') });
