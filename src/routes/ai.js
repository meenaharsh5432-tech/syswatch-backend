const Anthropic = require('@anthropic-ai/sdk');
const { collectSystemMetrics } = require('../collectors/system');
const { collectDockerMetrics } = require('../collectors/docker');
const { getMetricHistory, getLogs, getAgentById, insertAiRequest, getAiStats } = require('../db');
const { optionalAuth } = require('../middleware/auth');

let anthropic = null;

function getClient() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

async function aiRoutes(fastify) {
  // POST /api/analyze — one-shot system analysis
  fastify.post('/api/analyze', { preHandler: [optionalAuth] }, async (req, reply) => {
    if (req.user && req.user.plan !== 'pro') {
      return reply.status(403).send({
        error: 'upgrade_required',
        message: 'AI analysis requires the Pro plan. Upgrade at /billing.'
      });
    }

    const client = getClient();
    if (!client) {
      return reply.status(503).send({ error: 'api_not_configured', message: 'ANTHROPIC_API_KEY not configured' });
    }

    try {
      const agentId = req.body?.agentId ? parseInt(req.body.agentId) : null;

      const [system, containers, history, errorLogs] = await Promise.all([
        collectSystemMetrics(),
        collectDockerMetrics(),
        getMetricHistory(20, agentId),
        getLogs(10, 'error', agentId)
      ]);

      const snapshot = { current: system, containers, metricHistory: history, recentErrors: errorLogs };

      const start = Date.now();
      const message = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are an expert SRE AI. Analyze the system snapshot and return ONLY a JSON object with keys: severity (normal|warning|critical), headline (string), findings (array of strings), prediction (string), action (string). Do not include any other text or markdown.`,
        messages: [{ role: 'user', content: `Analyze this system snapshot:\n${JSON.stringify(snapshot, null, 2)}` }]
      });
      const latencyMs = Date.now() - start;

      const { input_tokens, output_tokens } = message.usage;
      await insertAiRequest({ type: 'analyze', inputTokens: input_tokens, outputTokens: output_tokens, latencyMs, agentId });

      const rawText = message.content[0]?.text || '{}';
      let analysis;
      try {
        analysis = JSON.parse(rawText.replace(/```json?\s*/gi, '').replace(/```/g, '').trim());
      } catch {
        analysis = {
          severity: 'normal',
          headline: 'Analysis complete',
          findings: [rawText],
          prediction: 'Unable to parse structured response',
          action: 'Review raw output'
        };
      }

      const usage = { inputTokens: input_tokens, outputTokens: output_tokens, latencyMs };
      return reply.send({ ok: true, analysis, usage, timestamp: new Date().toISOString() });
    } catch (err) {
      fastify.log.error(err);
      if (err.status === 429) return reply.status(429).send({ error: 'Rate limit reached, try again shortly' });
      return reply.status(500).send({ error: 'AI analysis failed: ' + err.message });
    }
  });

  // POST /api/chat — conversational AI with live system context
  fastify.post('/api/chat', { preHandler: [optionalAuth] }, async (req, reply) => {
    if (req.user && req.user.plan !== 'pro') {
      return reply.status(403).send({
        error: 'upgrade_required',
        message: 'AI chat requires the Pro plan. Upgrade at /billing.'
      });
    }

    const client = getClient();
    if (!client) {
      return reply.status(503).send({ error: 'api_not_configured', message: 'ANTHROPIC_API_KEY not configured' });
    }

    try {
      const { messages = [], agentId } = req.body || {};
      if (!messages.length) return reply.status(400).send({ error: 'messages_required' });

      const parsedAgentId = agentId ? parseInt(agentId) : null;

      const [system, history, recentLogs] = await Promise.all([
        collectSystemMetrics(),
        getMetricHistory(10, parsedAgentId),
        getLogs(15, null, parsedAgentId)
      ]);

      const systemPrompt = `You are an expert SRE (Site Reliability Engineer) AI assistant embedded in a server monitoring dashboard. You have real-time access to the server's metrics and logs shown below. Answer questions concisely and technically. Interpret metric data meaningfully — don't just repeat numbers, explain what they mean.

=== LIVE SYSTEM SNAPSHOT ===
${JSON.stringify({ current: system, recentMetrics: history, recentLogs }, null, 2)}
=== END SNAPSHOT ===`;

      const start = Date.now();
      const message = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      });
      const latencyMs = Date.now() - start;

      const { input_tokens, output_tokens } = message.usage;
      await insertAiRequest({ type: 'chat', inputTokens: input_tokens, outputTokens: output_tokens, latencyMs, agentId: parsedAgentId });

      return reply.send({
        ok: true,
        content: message.content[0]?.text || '',
        usage: { inputTokens: input_tokens, outputTokens: output_tokens, latencyMs }
      });
    } catch (err) {
      fastify.log.error(err);
      if (err.status === 429) return reply.status(429).send({ error: 'Rate limit reached, try again shortly' });
      return reply.status(500).send({ error: 'Chat failed: ' + err.message });
    }
  });

  // GET /api/ai/stats — aggregate LLM usage metrics
  fastify.get('/api/ai/stats', { preHandler: [optionalAuth] }, async (req, reply) => {
    try {
      const stats = await getAiStats();
      return reply.send(stats);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to retrieve AI stats' });
    }
  });
}

module.exports = aiRoutes;
