const si = require('systeminformation');

async function collectSystemMetrics() {
  try {
    const [cpuLoad, mem, memLayout, fsSizes, netStats] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.memLayout(),
      si.fsSize(),
      si.networkStats()
    ]);

    const cpu = parseFloat((cpuLoad.currentLoad ?? 0).toFixed(1));

    const physicalTotal = memLayout.reduce((sum, m) => sum + (m.size || 0), 0);
    const memTotal = physicalTotal > 0 ? physicalTotal : mem.total ?? 1;
    const memUsed = Math.min(mem.active ?? mem.used ?? 0, memTotal);
    const memory = {
      used: memUsed,
      total: memTotal,
      usedPercent: parseFloat(((memUsed / memTotal) * 100).toFixed(1))
    };

    const fsEntry = fsSizes && fsSizes.length > 0 ? fsSizes[0] : {};
    const disk = {
      usePct: parseFloat((fsEntry.use ?? 0).toFixed(1)),
      readMBps: parseFloat(((fsEntry.rw ?? 0) / 1024 / 1024).toFixed(2))
    };

    const netEntry = netStats && netStats.length > 0 ? netStats[0] : {};
    const network = {
      rxMbps: parseFloat(((netEntry.rx_sec ?? 0) * 8 / 1024 / 1024).toFixed(3)),
      txMbps: parseFloat(((netEntry.tx_sec ?? 0) * 8 / 1024 / 1024).toFixed(3))
    };

    return {
      cpu,
      memory,
      disk,
      network,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('[SystemCollector] Error:', err.message);
    return {
      cpu: 0,
      memory: { used: 0, total: 1, usedPercent: 0 },
      disk: { usePct: 0, readMBps: 0 },
      network: { rxMbps: 0, txMbps: 0 },
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = { collectSystemMetrics };
