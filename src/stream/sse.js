const { collectSystemMetrics } = require('../collectors/system');
const { collectDockerMetrics } = require('../collectors/docker');
const { insertMetric, getLogs } = require('../db');
const { emitAppLog } = require('../collectors/logs');

// Map from target ('local' | agentId string) → Set<response>
const clientsByTarget = new Map();

function addClient(res, target = 'local') {
  if (!clientsByTarget.has(target)) {
    clientsByTarget.set(target, new Set());
  }
  clientsByTarget.get(target).add(res);

  res.raw.on('close', () => {
    const set = clientsByTarget.get(target);
    if (set) {
      set.delete(res);
      if (set.size === 0) clientsByTarget.delete(target);
    }
  });
}

function broadcast(data, target = 'local') {
  const set = clientsByTarget.get(target);
  if (!set || set.size === 0) return;

  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const dead = [];

  for (const res of set) {
    try {
      res.raw.write(payload);
    } catch {
      dead.push(res);
    }
  }
  dead.forEach(r => set.delete(r));
}

function getClientCount() {
  let total = 0;
  for (const set of clientsByTarget.values()) total += set.size;
  return total;
}

async function collectAndBroadcast() {
  try {
    const [system, containers] = await Promise.all([
      collectSystemMetrics(),
      collectDockerMetrics()
    ]);

    insertMetric(system);

    const level = (system.cpu > 85 || system.memory.usedPercent > 90) ? 'ERROR'
      : (system.cpu > 70 || system.memory.usedPercent > 75) ? 'WARN' : 'INFO';
    emitAppLog(level, 'syswatch', `CPU ${system.cpu}% · MEM ${system.memory.usedPercent}% · DISK ${system.disk.usePct}%`);

    const recentLogs = getLogs(20);
    broadcast({ type: 'metrics', data: { system, containers, recentLogs } }, 'local');
  } catch (err) {
    console.error('[SSE] collectAndBroadcast error:', err.message);
  }
}

function startBroadcastLoop(intervalMs = 5000) {
  setInterval(collectAndBroadcast, intervalMs);
  collectAndBroadcast();
  console.log('[SSE] Broadcast loop started, interval:', intervalMs, 'ms');
}

module.exports = { addClient, broadcast, getClientCount, startBroadcastLoop, collectAndBroadcast };
