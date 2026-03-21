#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const os = require('os');
const osTotalMem = os.totalmem();

const SYSWATCH_URL = process.env.SYSWATCH_URL || 'http://localhost:3001';
const AGENT_KEY = process.env.AGENT_KEY;
const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
const INTERVAL = parseInt(process.env.INTERVAL) || 5000;

if (!AGENT_KEY) {
  console.error('[syswatch-agent] AGENT_KEY environment variable is required');
  process.exit(1);
}

let si;
try {
  si = require('systeminformation');
} catch {
  console.error('[syswatch-agent] systeminformation package not found. Run: npm install systeminformation');
  process.exit(1);
}

async function collectMetrics() {
  const [cpuLoad, mem, fsSizes, netStats] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats()
  ]);

  const fsEntry = fsSizes?.[0] || {};
  const netEntry = netStats?.[0] || {};

  const memTotal = osTotalMem;
  const memUsed = Math.min(mem.active ?? mem.used, memTotal);
  const pageFile = Math.max(0, (mem.total ?? 0) - memTotal);

  return {
    cpu: parseFloat((cpuLoad.currentLoad || 0).toFixed(1)),
    memory: {
      used: memUsed,
      total: memTotal,
      pageFile,
      usedPercent: parseFloat(((memUsed / memTotal) * 100).toFixed(1))
    },
    disk: {
      usePct: parseFloat((fsEntry.use || 0).toFixed(1)),
      readMBps: parseFloat(((fsEntry.rw || 0) / 1024 / 1024).toFixed(2))
    },
    network: {
      rxMbps: parseFloat(((netEntry.rx_sec || 0) * 8 / 1024 / 1024).toFixed(3)),
      txMbps: parseFloat(((netEntry.tx_sec || 0) * 8 / 1024 / 1024).toFixed(3))
    },
    hostname: AGENT_NAME,
    timestamp: new Date().toISOString()
  };
}

function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(SYSWATCH_URL);
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = JSON.stringify(body);

    const req = lib.request({
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Agent-Key': AGENT_KEY
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });

    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendLog(level, message) {
  try {
    await post('/api/ingest/logs', { level, service: AGENT_NAME, message });
  } catch {
    // silently ignore log send failures
  }
}

let tickCount = 0;

async function tick() {
  try {
    const metrics = await collectMetrics();
    const result = await post('/api/ingest/metrics', { metrics, agentName: AGENT_NAME });
    if (result.status !== 200 && result.status !== 201) {
      console.error('[agent] Ingest failed:', result.status, result.body);
      await sendLog('ERROR', `Metrics ingest failed with status ${result.status}`);
    } else {
      // Send a heartbeat log every 12 ticks (~60s at default 5s interval)
      tickCount++;
      if (tickCount % 12 === 1) {
        const level = (metrics.cpu > 85 || metrics.memory.usedPercent > 90) ? 'ERROR'
          : (metrics.cpu > 70 || metrics.memory.usedPercent > 75) ? 'WARN' : 'INFO';
        await sendLog(level, `CPU ${metrics.cpu}% · MEM ${metrics.memory.usedPercent}% · DISK ${metrics.disk.usePct}%`);
      }
    }
  } catch (err) {
    console.error('[agent] Error:', err.message || err);
    await sendLog('ERROR', `Agent error: ${err.message || String(err)}`);
  }
}

console.log(`[SysWatch Agent] Starting`);
console.log(`  Backend : ${SYSWATCH_URL}`);
console.log(`  Agent   : ${AGENT_NAME}`);
console.log(`  Interval: ${INTERVAL}ms`);

tick();
setInterval(tick, INTERVAL);

process.on('SIGTERM', () => { console.log('[agent] Stopping'); process.exit(0); });
process.on('SIGINT', () => process.exit(0));
