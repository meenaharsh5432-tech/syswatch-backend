const { createAgent, getAgentsByUserId, getAgentById, deleteAgent } = require('../db');
const { requireAuth } = require('../middleware/auth');

async function agentsRoutes(fastify) {
  // GET /api/agents
  fastify.get('/api/agents', { preHandler: [requireAuth] }, async (req, reply) => {
    const agents = await getAgentsByUserId(req.user.userId);
    return reply.send(agents.map(({ api_key, ...safe }) => safe));
  });

  // POST /api/agents
  fastify.post('/api/agents', { preHandler: [requireAuth] }, async (req, reply) => {
    const { name } = req.body || {};
    if (!name?.trim()) {
      return reply.status(400).send({ error: 'validation_error', message: 'Agent name is required' });
    }

    const agent = await createAgent(req.user.userId, name.trim());
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
    const installCommand = `curl -sSL ${backendUrl}/install.sh | SYSWATCH_URL=${backendUrl} AGENT_KEY=${agent.api_key} bash`;

    return reply.status(201).send({
      agent: { id: agent.id, name: agent.name, status: 'offline', created_at: agent.created_at },
      apiKey: agent.api_key,
      installCommand
    });
  });

  // GET /api/agents/:id
  fastify.get('/api/agents/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const agent = await getAgentById(parseInt(req.params.id));
    if (!agent || agent.user_id !== req.user.userId) {
      return reply.status(404).send({ error: 'not_found', message: 'Agent not found' });
    }
    const { api_key, ...safe } = agent;
    return reply.send(safe);
  });

  // DELETE /api/agents/:id
  fastify.delete('/api/agents/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const agentId = parseInt(req.params.id);
    const agent = await getAgentById(agentId);
    if (!agent || agent.user_id !== req.user.userId) {
      return reply.status(404).send({ error: 'not_found', message: 'Agent not found' });
    }
    await deleteAgent(agentId, req.user.userId);
    return reply.send({ ok: true });
  });
}

module.exports = agentsRoutes;
