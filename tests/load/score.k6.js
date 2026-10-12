// Phase 9 (NFR-001/002/004) k6 load scenario against `POST /api/v1/fraud/score`.
//
// An *open-model* (arrival-rate) executor, not a VU-count one: NFR-001 is
// specified as a throughput target ("sustained TPS"), and only
// `ramping-arrival-rate` actually drives requests at a fixed rate regardless
// of how slow the server gets — a closed VU-pool model would silently throttle
// itself the moment the server slows down, hiding the exact degradation this
// phase exists to measure.
//
// Each simulated VU is given its own spoofed source IP via `X-Forwarded-For`.
// `fraud-api`'s FastifyAdapter is built with `trustProxy: true` (`main.ts`) and
// `@fastify/rate-limit` keys on `request.ip` with no override — so a load test
// run from ONE real machine, with no per-VU IP diversity, would hit
// `RATE_LIMIT_MAX_REQUESTS=100`/second-per-client almost immediately at any of
// this phase's target rates and measure the rate limiter, not the platform.
// `trustProxy` exists specifically so a real gateway in front of many real
// merchant IPs is honoured correctly — this is that same mechanism, used
// honestly to simulate many distinct clients instead of raising the limit
// artificially for the test.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URLS = (__ENV.BASE_URLS || 'http://127.0.0.1:3000').split(',').map((s) => s.trim());
const TOKEN = __ENV.TOKEN;
const RUN_ID = __ENV.RUN_ID || 'loadtest';
const TARGET_RPS = Number(__ENV.TARGET_RPS || 10);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 10);
const STEADY_SECONDS = Number(__ENV.STEADY_SECONDS || 30);
// Generous — this measures whether the SERVER sheds/degrades, not whether k6
// gives up waiting. A real client would also wait out a slow decision.
const REQUEST_TIMEOUT = __ENV.REQUEST_TIMEOUT || '3s';

if (!TOKEN) {
  throw new Error('TOKEN env var is required (a signed score-privilege JWT)');
}

const decisions = new Counter('fraudguard_decisions_total');
const shed = new Counter('fraudguard_shed_total');
const degraded = new Counter('fraudguard_degraded_total');
const otherStatus = new Counter('fraudguard_unexpected_status_total');
const decisionLatency = new Trend('fraudguard_decision_latency_ms', true);

export const options = {
  scenarios: {
    score_at_target_rps: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.floor(TARGET_RPS * 0.1)),
      timeUnit: '1s',
      preAllocatedVUs: Math.min(4000, Math.max(50, TARGET_RPS * 2)),
      maxVUs: Math.min(6000, Math.max(100, TARGET_RPS * 4)),
      stages: [
        { target: TARGET_RPS, duration: `${RAMP_SECONDS}s` },
        { target: TARGET_RPS, duration: `${STEADY_SECONDS}s` },
        { target: 0, duration: '5s' },
      ],
    },
  },
  // Thresholds are informational here (the orchestrator does PASS/DEGRADED/
  // FAILED against the actual NFR numbers from real Prometheus + k6 data,
  // not from k6's own pass/fail), so a threshold "failing" must never abort
  // the run early.
  thresholds: {},
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function spoofedIpFor(vu) {
  const a = 10;
  const b = Math.floor(vu / (256 * 256)) % 256;
  const c = Math.floor(vu / 256) % 256;
  const d = vu % 256 || 1;
  return `${a}.${b}.${c}.${d}`;
}

export default function () {
  const base = BASE_URLS[__VU % BASE_URLS.length];
  const transactionId = `${RUN_ID}_${__VU}_${__ITER}`;
  const payload = JSON.stringify({
    transactionId,
    userId: `${RUN_ID}_user_${__VU}`,
    merchantId: `${RUN_ID}_merchant_${__VU % 97}`,
    deviceId: `${RUN_ID}_device_${__VU}`,
    amount: { minorUnits: 1000 + ((__VU * 37 + __ITER) % 500000), currency: 'USD' },
    paymentMethod: 'card_token_loadtest',
    ipAddress: '203.0.113.42',
    timestamp: new Date().toISOString(),
  });

  const res = http.post(`${base}/api/v1/fraud/score`, payload, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'x-forwarded-for': spoofedIpFor(__VU),
    },
    timeout: REQUEST_TIMEOUT,
    tags: { name: 'score' },
  });

  if (res.status === 200) {
    decisions.add(1);
    decisionLatency.add(res.timings.duration);
    let body;
    try {
      body = res.json();
    } catch {
      body = undefined;
    }
    if (body && body.degraded) {
      degraded.add(1);
    }
    check(res, { 'status is 200': () => true });
  } else if (res.status === 429) {
    shed.add(1);
  } else {
    otherStatus.add(1);
  }
}
