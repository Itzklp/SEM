// Loaded via `node -r ./preload.js` / `ts-node-dev -r ./preload.js` —
// BEFORE src/main.ts is ever required. Same reasoning as
// apps/fraud-api/preload.js: main.ts's own import graph (which calls
// loadConfig() eagerly) gets hoisted above anything written later in the
// same file, so .env has to load from outside that graph entirely.
const path = require('node:path');
const { config } = require('dotenv');

config({ path: path.join(__dirname, '..', '..', '.env') });
