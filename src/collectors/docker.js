let Docker;
try {
  Docker = require('dockerode');
} catch {
  Docker = null;
}

let docker = null;

function getDockerClient() {
  if (!Docker) return null;
  if (!docker) {
    try {
      const isWindows = process.platform === 'win32';
      docker = isWindows
        ? new Docker({ socketPath: '//./pipe/docker_engine' })
        : new Docker({ socketPath: '/var/run/docker.sock' });
    } catch {
      return null;
    }
  }
  return docker;
}

async function getContainerStats(container) {
  return new Promise((resolve) => {
    container.stats({ stream: false }, (err, data) => {
      if (err || !data) {
        resolve({ cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0 });
        return;
      }
      try {
        const cpuDelta = data.cpu_stats.cpu_usage.total_usage - data.precpu_stats.cpu_usage.total_usage;
        const systemDelta = data.cpu_stats.system_cpu_usage - data.precpu_stats.system_cpu_usage;
        const numCpus = data.cpu_stats.online_cpus || data.cpu_stats.cpu_usage.percpu_usage?.length || 1;
        const cpu_percent = systemDelta > 0 ? parseFloat(((cpuDelta / systemDelta) * numCpus * 100).toFixed(2)) : 0;

        const memory_mb = parseFloat((data.memory_stats.usage / 1024 / 1024).toFixed(1));
        const memory_limit_mb = parseFloat((data.memory_stats.limit / 1024 / 1024).toFixed(1));

        resolve({ cpu_percent, memory_mb, memory_limit_mb });
      } catch {
        resolve({ cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0 });
      }
    });
  });
}

async function collectDockerMetrics() {
  const client = getDockerClient();
  if (!client) return [];

  try {
    const containers = await client.listContainers({ all: true });
    const results = await Promise.all(
      containers.map(async (info) => {
        const name = (info.Names[0] || info.Id).replace(/^\//, '');
        const isRunning = info.State === 'running';
        let stats = { cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0 };

        if (isRunning) {
          try {
            const container = client.getContainer(info.Id);
            stats = await getContainerStats(container);
          } catch {
            // stats remain zeroed
          }
        }

        return {
          id: info.Id.substring(0, 12),
          name,
          status: info.State,
          image: info.Image,
          cpu_percent: stats.cpu_percent,
          memory_mb: stats.memory_mb,
          memory_limit_mb: stats.memory_limit_mb
        };
      })
    );
    return results;
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') {
      console.error('[DockerCollector] Error:', err.message);
    }
    return [];
  }
}

module.exports = { collectDockerMetrics };
