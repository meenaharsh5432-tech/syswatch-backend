const { getLogs, insertLog } = require('../db');
const { broadcast } = require('../stream/sse');

async function logsRoutes(fastify) {
  fastify.get('/api/logs', async (req, reply) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
      const level = req.query.level || null;
      const logs = await getLogs(limit, level);
      return reply.send(logs);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to retrieve logs' });
    }
  });

  fastify.post('/api/logs', async (req, reply) => {
    try {
      const { level = 'INFO', service = 'external', message } = req.body || {};
      if (!message) {
        return reply.status(400).send({ error: 'message is required' });
      }

      const log = {
        timestamp: new Date().toISOString(),
        level: level.toUpperCase(),
        service,
        message: String(message).substring(0, 500)
      };

      const saved = await insertLog(log);
      broadcast({ type: 'log', data: saved });

      return reply.status(201).send({ ok: true, log });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to insert log' });
    }
  });
}

module.exports = logsRoutes;
