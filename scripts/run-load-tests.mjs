#!/usr/bin/env node
/**
 * Phase 9 (NFR-001/002/004) load-test orchestrator — `pnpm test:load`.
 *
 * Drives `tests/load/score.k6.js` at each target TPS in sequence and, for
 * each stage, measures:
 *   - client-side latency/throughput (k6's own summary)
 *   - server-side latency (diffed directly from fraud-api's own `/metrics`
 *     exposition, NOT reconstructed through Prometheus's rate()/scrape
 *     interval — this repo's Prometheus scrapes every 15s
 *     (`infrastructure/monitoring/prometheus/prometheus.yml`), far too
 *     coarse to resolve a histogram over a 20-45s steady window. Snapshotting
 *     the process's own cumulative histogram before and after, and taking the
 *     delta, gives an exact bucket count for exactly this run's requests,
 *     independent of any scrape cadence. Prometheus/Grafana stay useful for
 *     watching a run live; they are not this script's source of truth)
 *   - host resource use: `docker stats` for the containerised dependencies,
 *     `Get-Process`'s cumulative CPU time for the host-run `fraud-api`
 *     process (Windows has no /proc; this is the equivalent — a start/end
 *     sample of TotalProcessorTime, converted to a percentage over the
 *     run's wall-clock duration and this machine's logical core count)
 *
 * RISK-001 (DEVELOPMENT_ENVIRONMENT.md §5.2): k6 and fraud-api run
 * co-resident on this one 4-core/8-thread laptop. This script does not
 * paper over that — every result records both latency series and the
 * hardware caveat travels into the report, never silently dropped.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');
const RESULTS_DIR = `${ROOT}docs/testing/test-results/perf-runs`;
const SCORE_URL = process.env.FRAUD_API_URLS || 'http://127.0.0.1:3000';
const METRICS_URL = (SCORE_URL.split(',')[0]) + '/metrics';
const HEALTH_URL = (SCORE_URL.split(',')[0]) + '/api/v1/health';

mkdirSync(RESULTS_DIR, { recursive: true });

const STAGES = (process.env.STAGES || '500,1000,2000,5000,10000,20000')
  .split(',')
  .map((s) => Number(s.trim()));
const RAMP_SECONDS = Number(process.env.RAMP_SECONDS || 10);
const STEADY_SECONDS = Number(process.env.STEADY_SECONDS || 20);
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || 10);
const LOGICAL_CORES = 8; // i5-9300H: 4 physical / 8 logical (DEVELOPMENT_ENVIRONMENT.md §5.2) — Windows has no cgroup cpu.max to read back portably from Node.

function sh(cmd, args) {
  // bare `.exe`s (powershell, docker, k6) resolve fine without a shell.
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.stdout || '';
}

function shViaCmd(cmd, args) {
  // `pnpm` is a `.cmd` shim — needs `shell: true` (routes through cmd.exe)
  // to resolve at all. NEVER use this for a command containing `|` or `(`:
  // cmd.exe's own parser sees those before the target program does and
  // mangles anything meant for PowerShell (caught live, building this
  // script — the PID/CPU PowerShell one-liners below silently returned
  // nothing until split out from this path).
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: true });
  return r.stdout || '';
}

function signToken() {
  const out = shViaCmd('pnpm', ['--filter', '@fraudguard/testkit', 'sign-token', '14400']);
  const line = out.split('\n').find((l) => l.trim().startsWith('eyJ'));
  if (!line) throw new Error(`sign-token produced no JWT. Raw output:\n${out}`);
  return line.trim();
}

async function fetchText(url) {
  const res = await fetch(url);
  return res.text();
}

/** Parses Prometheus text exposition into { [metricLine]: value } keyed by the full label set, per metric name. */
function parseMetrics(text) {
  const byName = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^(\w+)(\{[^}]*\})?\s+([0-9eE+\-.]+|NaN|\+?Inf|-Inf)$/.exec(line.trim());
    if (!match) continue;
    const [, name, labels = '', valueRaw] = match;
    const value = valueRaw === 'NaN' ? NaN : valueRaw === '+Inf' ? Infinity : valueRaw === '-Inf' ? -Infinity : Number(valueRaw);
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name).set(labels, value);
  }
  return byName;
}

function labelsMatch(labelStr, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (!labelStr.includes(`${k}="${v}"`)) return false;
  }
  return true;
}

/** Sums delta cumulative-bucket counts for a histogram across all label sets matching `filter`, returning { buckets: Map<le, count>, sum, count }. */
function histogramDelta(before, after, baseName, filter) {
  const bucketsBefore = before.get(`${baseName}_bucket`) ?? new Map();
  const bucketsAfter = after.get(`${baseName}_bucket`) ?? new Map();
  const leTotals = new Map(); // le -> summed delta across matching series
  for (const [labelStr, afterVal] of bucketsAfter) {
    if (!labelsMatch(labelStr, filter)) continue;
    const leMatch = /le="([^"]+)"/.exec(labelStr);
    const le = leMatch ? leMatch[1] : '+Inf';
    const beforeVal = bucketsBefore.get(labelStr) ?? 0;
    const delta = Math.max(0, afterVal - beforeVal);
    leTotals.set(le, (leTotals.get(le) ?? 0) + delta);
  }
  const sumBefore = sumMatching(before.get(`${baseName}_sum`), filter);
  const sumAfter = sumMatching(after.get(`${baseName}_sum`), filter);
  const countBefore = sumMatching(before.get(`${baseName}_count`), filter);
  const countAfter = sumMatching(after.get(`${baseName}_count`), filter);
  return {
    buckets: leTotals,
    sum: Math.max(0, sumAfter - sumBefore),
    count: Math.max(0, countAfter - countBefore),
  };
}

function sumMatching(seriesMap, filter) {
  if (!seriesMap) return 0;
  let total = 0;
  for (const [labelStr, value] of seriesMap) {
    if (labelsMatch(labelStr, filter)) total += value;
  }
  return total;
}

/** Same linear-interpolation-within-bucket algorithm Prometheus's own histogram_quantile() uses. */
function quantileFromBuckets(leTotals, totalCount, q) {
  if (totalCount <= 0) return null;
  const entries = [...leTotals.entries()]
    .map(([le, count]) => [le === '+Inf' ? Infinity : Number(le), count])
    .sort((a, b) => a[0] - b[0]);
  const target = q * totalCount;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, cumulative] of entries) {
    if (cumulative >= target) {
      if (!Number.isFinite(le)) return prevLe; // target falls in the +Inf bucket — can't interpolate further, report the last finite boundary
      const bucketCount = cumulative - prevCount;
      if (bucketCount <= 0) return le;
      const frac = (target - prevCount) / bucketCount;
      return prevLe + frac * (le - prevLe);
    }
    prevLe = le;
    prevCount = cumulative;
  }
  return prevLe;
}

function serverSideStats(before, after, route) {
  const filter = { route };
  const h = histogramDelta(before, after, 'request_duration_seconds', filter);
  const totalBucketCount = [...h.buckets.values()].reduce((a, b) => Math.max(a, b), 0); // cumulative, last (+Inf) bucket IS the total
  const infCount = h.buckets.get('+Inf') ?? totalBucketCount;
  return {
    count: h.count || infCount,
    avgMs: h.count > 0 ? (h.sum / h.count) * 1000 : null,
    p50Ms: msOrNull(quantileFromBuckets(h.buckets, infCount, 0.5)),
    p95Ms: msOrNull(quantileFromBuckets(h.buckets, infCount, 0.95)),
    p99Ms: msOrNull(quantileFromBuckets(h.buckets, infCount, 0.99)),
  };
}

function msOrNull(seconds) {
  return seconds === null ? null : Math.round(seconds * 1000 * 100) / 100;
}

function errorCount(before, after, route) {
  const b = sumMatching(before.get('request_errors_total'), { route });
  const a = sumMatching(after.get('request_errors_total'), { route });
  return Math.max(0, a - b);
}

function hotPathStageBreakdown(before, after) {
  const stages = ['idempotency_check', 'feature_fetch', 'score', 'decide', 'persist'];
  const out = {};
  for (const stage of stages) {
    const h = histogramDelta(before, after, 'fraud_score_duration_seconds', { stage });
    const inf = h.buckets.get('+Inf') ?? 0;
    out[stage] = { avgMs: h.count > 0 ? (h.sum / h.count) * 1000 : null, p99Ms: msOrNull(quantileFromBuckets(h.buckets, inf, 0.99)) };
  }
  return out;
}

function fraudApiPid() {
  const out = sh('powershell.exe', [
    '-NoProfile', '-Command',
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)",
  ]);
  const pid = Number(out.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function processCpuSeconds(pid) {
  if (!pid) return null;
  const out = sh('powershell.exe', [
    '-NoProfile', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds`,
  ]);
  const v = Number(out.trim());
  return Number.isFinite(v) ? v : null;
}

function dockerStatsSnapshot() {
  const out = sh('docker', [
    'stats', '--no-stream', '--format', '{{.Name}},{{.CPUPerc}},{{.MemUsage}}',
  ]);
  const rows = {};
  for (const line of out.trim().split('\n')) {
    const [name, cpu, mem] = line.split(',');
    if (!name) continue;
    rows[name] = { cpuPercent: parseFloat(cpu), mem: (mem || '').split('/')[0]?.trim() };
  }
  return rows;
}

/**
 * Caught live: the very first smoke run of this script measured Redis
 * `commandTimeout` (20ms, ADR-002) tripping repeatedly within the first
 * second of an otherwise-trivial 50 TPS stage, even freshly after
 * restarting `fraud-api`. Root cause isn't load — it's V8/ts-node JIT
 * warm-up and Fastify's cold route/Zod-schema compilation competing with
 * the single-connection ioredis client's event-loop timers for the first
 * few dozen requests of the PROCESS's life, not of this stage. A handful
 * of real, sequential requests before each stage's measurement window
 * opens burns through that one-time cost so what gets measured is this
 * stage's own steady-state behaviour — standard load-testing practice
 * (k6 itself recommends a warm-up), not softening the numbers.
 */
async function warmUp(baseUrl, token, count = 30) {
  for (let i = 0; i < count; i += 1) {
    await fetch(`${baseUrl}/api/v1/fraud/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        transactionId: `warmup_${Date.now()}_${i}`,
        userId: 'warmup_user',
        merchantId: 'warmup_merchant',
        deviceId: 'warmup_device',
        amount: { minorUnits: 1000, currency: 'USD' },
        paymentMethod: 'card_token_warmup',
        ipAddress: '203.0.113.99',
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => undefined);
  }
}

async function runStage(targetRps, token, baseUrlsCsv) {
  const runId = `perf_${Date.now()}_${targetRps}`;
  console.log(`\n=== Stage: ${targetRps} TPS target (run ${runId}) ===`);

  await warmUp(baseUrlsCsv.split(',')[0], token);

  const pid = fraudApiPid();
  const before = parseMetrics(await fetchText(METRICS_URL));
  const cpuBefore = processCpuSeconds(pid);
  const wallStart = Date.now();

  const dockerSamples = [];
  const samplerHandle = setInterval(() => dockerSamples.push(dockerStatsSnapshot()), 5000);

  const summaryPath = `${RESULTS_DIR}/${runId}.k6-summary.json`;
  const logPath = `${RESULTS_DIR}/${runId}.k6.log`;
  const k6 = spawn(
    'k6.exe',
    [
      'run',
      '--env', `TOKEN=${token}`,
      '--env', `RUN_ID=${runId}`,
      '--env', `TARGET_RPS=${targetRps}`,
      '--env', `RAMP_SECONDS=${RAMP_SECONDS}`,
      '--env', `STEADY_SECONDS=${STEADY_SECONDS}`,
      '--env', `BASE_URLS=${baseUrlsCsv}`,
      '--summary-export', summaryPath,
      '--quiet',
      `${ROOT}tests/load/score.k6.js`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  k6.stdout.on('data', (d) => (log += d));
  k6.stderr.on('data', (d) => (log += d));
  const exitCode = await new Promise((resolve) => k6.on('close', resolve));
  writeFileSync(logPath, log);

  clearInterval(samplerHandle);
  // Drain check — `/health` is exempt from the concurrency ceiling
  // (`load-shedding.ts`), so a clean "not overloaded" response here is a
  // real signal the in-flight counter actually returned to baseline, not
  // just that k6 stopped generating traffic. Caught live: before the
  // ceiling counter's abort-leak fix, this would have spun for the full
  // 15s every stage, forever, instead of confirming drainage.
  for (let i = 0; i < 15; i += 1) {
    const stillOverloaded = (await fetchText(HEALTH_URL).catch(() => '')).includes('OVERLOADED');
    if (!stillOverloaded) break;
    await sleep(1000);
  }
  const wallEnd = Date.now();
  const cpuAfter = processCpuSeconds(pid);
  const after = parseMetrics(await fetchText(METRICS_URL));

  const k6Summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const m = k6Summary.metrics;

  const route = '/api/v1/fraud/score';
  const server = serverSideStats(before, after, route);
  const errors = errorCount(before, after, route);
  const hotPath = hotPathStageBreakdown(before, after);

  const elapsedSeconds = (wallEnd - wallStart) / 1000;
  const fraudApiCpuPercent =
    cpuBefore !== null && cpuAfter !== null
      ? Math.round(((cpuAfter - cpuBefore) / elapsedSeconds / LOGICAL_CORES) * 10000) / 100
      : null;

  const achievedRps = m.http_reqs?.rate ?? null;
  const shed = m.fraudguard_shed_total?.count ?? 0;
  const degraded = m.fraudguard_degraded_total?.count ?? 0;
  const unexpected = m.fraudguard_unexpected_status_total?.count ?? 0;
  const httpReqFailedRate = m.http_req_failed?.rate ?? null;

  const result = {
    runId,
    targetRps,
    exitCode,
    elapsedSeconds,
    client: {
      achievedRps,
      p50Ms: m.http_req_duration?.['p(50)'] ?? null,
      p95Ms: m.http_req_duration?.['p(95)'] ?? null,
      p99Ms: m.http_req_duration?.['p(99)'] ?? null,
      maxMs: m.http_req_duration?.max ?? null,
      httpReqFailedRate,
    },
    server,
    hotPath,
    shed429Count: shed,
    degradedCount: degraded,
    unexpectedStatusCount: unexpected,
    serverSideErrorCount: errors,
    fraudApiCpuPercent,
    dockerStats: dockerSamples,
  };

  writeFileSync(`${RESULTS_DIR}/${runId}.result.json`, JSON.stringify(result, null, 2));
  console.log(
    `  achieved ${achievedRps?.toFixed(1)} req/s | client p99 ${result.client.p99Ms?.toFixed(1)}ms | server p99 ${server.p99Ms}ms | shed=${shed} degraded=${degraded} errors=${errors} | fraud-api CPU ${fraudApiCpuPercent}%`,
  );
  return result;
}

async function main() {
  const health = await fetchText(HEALTH_URL).catch(() => null);
  if (!health) {
    console.error(`fraud-api is not reachable at ${HEALTH_URL}. Start it first (pnpm --filter @fraudguard/fraud-api dev).`);
    process.exit(1);
  }
  console.log('fraud-api health:', health);

  const token = signToken();
  const baseUrlsCsv = SCORE_URL;
  const results = [];
  for (const tps of STAGES) {
    const result = await runStage(tps, token, baseUrlsCsv);
    results.push(result);
    if (tps !== STAGES[STAGES.length - 1]) {
      console.log(`  cooling down ${COOLDOWN_SECONDS}s before next stage...`);
      await sleep(COOLDOWN_SECONDS * 1000);
    }
  }

  const outPath = `${RESULTS_DIR}/summary-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nAll stages complete. Summary: ${outPath}`);
}

main();
