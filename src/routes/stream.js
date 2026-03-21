const { addClient } = require('../stream/sse');

async function streamRoutes(fastify) {
  fastify.get('/api/stream', async (req, reply) => {
    // agentId query param scopes the stream; 'local' = local system metrics
    const agentId = req.query.agentId || 'local';

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });

    reply.raw.write('data: {"type":"connected"}\n\n');
    addClient(reply, agentId);

    const keepAlive = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
    }, 30000);

    req.raw.on('close', () => clearInterval(keepAlive));
  });
}

module.exports = streamRoutes;
