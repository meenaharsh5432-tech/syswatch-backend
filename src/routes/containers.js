const { collectDockerMetrics } = require('../collectors/docker');

async function containersRoutes(fastify) {
  fastify.get('/api/containers', async (req, reply) => {
    try {
      const containers = await collectDockerMetrics();
      return reply.send(containers);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to retrieve container info' });
    }
  });
}

module.exports = containersRoutes;
