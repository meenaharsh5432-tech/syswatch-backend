const { collectSystemMetrics } = require('../collectors/system');
const { getMetricHistory } = require('../db');
const { optionalAuth } = require('../middleware/auth');

async function metricsRoutes(fastify) {
  fastify.get('/api/metrics/current', async (req, reply) => {
    try {
      const metrics = await collectSystemMetrics();
      return reply.send(metrics);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to collect metrics' });
    }
  });

  fastify.get('/api/metrics/history', { preHandler: [optionalAuth] }, async (req, reply) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 60, 1000);
      const agentId = req.query.agentId ? parseInt(req.query.agentId) : null;
      const history = getMetricHistory(limit, agentId);
      return reply.send(history);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to retrieve metric history' });
    }
  });
}

module.exports = metricsRoutes;
