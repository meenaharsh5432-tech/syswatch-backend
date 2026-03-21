const { getAgentByApiKey, updateAgentLastSeen, insertMetric, insertLog, getLogs } = require('../db');
const { broadcast } = require('../stream/sse');

async function ingestRoutes(fastify) {
  async function requireAgentKey(req, reply) {
    const key = req.headers['x-agent-key'];
    if (!key) {
      return reply.status(401).send({ error: 'missing_key', message: 'X-Agent-Key header is required' });
    }
    const agent = getAgentByApiKey(key);
    if (!agent) {
      return reply.status(401).send({ error: 'invalid_key', message: 'Invalid agent API key' });
    }
    req.agent = agent;
  }

  // POST /api/ingest/metrics
  fastify.post('/api/ingest/metrics', { preHandler: [requireAgentKey] }, async (req, reply) => {
    const { metrics } = req.body || {};
    if (!metrics) return reply.status(400).send({ error: 'metrics_required', message: 'metrics field is required' });

    updateAgentLastSeen(req.agent.id);
    insertMetric(metrics, req.agent.id);

    const recentLogs = getLogs(20, null, req.agent.id);
    broadcast(
      { type: 'metrics', data: { system: metrics, containers: [], recentLogs } },
      String(req.agent.id)
    );

    return reply.send({ ok: true });
  });

  // POST /api/ingest/logs
  fastify.post('/api/ingest/logs', { preHandler: [requireAgentKey] }, async (req, reply) => {
    const { level = 'INFO', service = 'agent', message } = req.body || {};
    if (!message) return reply.status(400).send({ error: 'message_required', message: 'message field is required' });

    updateAgentLastSeen(req.agent.id);

    const log = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service,
      message: String(message).substring(0, 500)
    };

    insertLog(log, req.agent.id);
    broadcast({ type: 'log', data: log }, String(req.agent.id));

    return reply.send({ ok: true });
  });

  // GET /api/ingest/ping — heartbeat for agents
  fastify.get('/api/ingest/ping', { preHandler: [requireAgentKey] }, async (req, reply) => {
    updateAgentLastSeen(req.agent.id);
    return reply.send({ ok: true, agentId: req.agent.id, timestamp: new Date().toISOString() });
  });
}

module.exports = ingestRoutes;
