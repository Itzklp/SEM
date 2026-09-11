// Same reasoning as apps/fraud-api/preload.js — .env has to load before
// main.ts's own import graph (which calls loadConfig() eagerly) runs.
const path = require('node:path');
const { config } = require('dotenv');

config({ path: path.join(__dirname, '..', '..', '.env') });
