const Anthropic = require('@anthropic-ai/sdk');
const { collectSystemMetrics } = require('../collectors/system');
const { collectDockerMetrics } = require('../collectors/docker');
const { getMetricHistory, getLogs, getAgentById } = require('../db');
const { optionalAuth } = require('../middleware/auth');

let anthropic = null;

function getClient() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

async function aiRoutes(fastify) {
  fastify.post('/api/analyze', { preHandler: [optionalAuth] }, async (req, reply) => {
    // If authenticated and free plan, block
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
        getMetricHistory(20, agentId, req.user?.plan || 'pro'),
        getLogs(10, 'error', agentId)
      ]);

      const snapshot = { current: system, containers, metricHistory: history, recentErrors: errorLogs };

      const message = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are an expert SRE AI. Analyze the system snapshot and return ONLY a JSON object with keys: severity (normal|warning|critical), headline (string), findings (array of strings), prediction (string), action (string). Do not include any other text or markdown.`,
        messages: [{ role: 'user', content: `Analyze this system snapshot:\n${JSON.stringify(snapshot, null, 2)}` }]
      });

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

      return reply.send({ ok: true, analysis, timestamp: new Date().toISOString() });
    } catch (err) {
      fastify.log.error(err);
      if (err.status === 429) return reply.status(429).send({ error: 'Rate limit reached, try again shortly' });
      return reply.status(500).send({ error: 'AI analysis failed: ' + err.message });
    }
  });
}

module.exports = aiRoutes;
