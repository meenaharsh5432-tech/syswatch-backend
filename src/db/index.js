const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'syswatch';

let client = null;
let db = null;

async function getNextId(name) {
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return result.seq;
}

async function initDB() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI environment variable is required');
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);

  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ google_id: 1 });
  await db.collection('users').createIndex({ id: 1 }, { unique: true });
  await db.collection('agents').createIndex({ api_key: 1 }, { unique: true });
  await db.collection('agents').createIndex({ user_id: 1 });
  await db.collection('agents').createIndex({ id: 1 }, { unique: true });
  await db.collection('logs').createIndex({ agent_id: 1, id: -1 });
  await db.collection('metrics_history').createIndex({ agent_id: 1, id: -1 });
  await db.collection('ai_requests').createIndex({ id: -1 });

  console.log('[DB] Connected to MongoDB Atlas');
}

// ---- Users ----
async function createUser({ email, name, avatar, google_id }) {
  const existing = await db.collection('users').findOne({ email }, { projection: { _id: 0 } });
  if (existing) return existing;
  const id = await getNextId('users');
  const user = {
    id, email,
    name: name || null,
    avatar: avatar || null,
    google_id: google_id || null,
    plan: 'free',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    created_at: new Date().toISOString()
  };
  await db.collection('users').insertOne(user);
  const { _id, ...safe } = user;
  return safe;
}

async function getUserById(id) {
  return db.collection('users').findOne({ id }, { projection: { _id: 0 } });
}

async function getUserByGoogleId(googleId) {
  return db.collection('users').findOne({ google_id: googleId }, { projection: { _id: 0 } });
}

async function getUserByStripeCustomer(customerId) {
  return db.collection('users').findOne({ stripe_customer_id: customerId }, { projection: { _id: 0 } });
}

async function updateUserPlan(userId, plan, stripeCustomerId = null, stripeSubId = null) {
  const update = { plan };
  if (stripeCustomerId) update.stripe_customer_id = stripeCustomerId;
  if (stripeSubId) update.stripe_subscription_id = stripeSubId;
  await db.collection('users').updateOne({ id: userId }, { $set: update });
}

// ---- Agents ----
function getAgentStatus(lastSeen) {
  if (!lastSeen) return 'offline';
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  if (diffMs < 30000) return 'online';
  if (diffMs < 120000) return 'degraded';
  return 'offline';
}

async function createAgent(userId, name) {
  const apiKey = 'sk-agent-' + crypto.randomBytes(24).toString('hex');
  const id = await getNextId('agents');
  const agent = {
    id, user_id: userId, name,
    api_key: apiKey,
    last_seen: null,
    created_at: new Date().toISOString()
  };
  await db.collection('agents').insertOne(agent);
  const { _id, ...safe } = agent;
  return safe;
}

async function getAgentsByUserId(userId) {
  const agents = await db.collection('agents').find({ user_id: userId }, { projection: { _id: 0 } }).toArray();
  return agents.map(a => ({ ...a, status: getAgentStatus(a.last_seen) }));
}

async function getAgentById(id) {
  const a = await db.collection('agents').findOne({ id }, { projection: { _id: 0 } });
  return a ? { ...a, status: getAgentStatus(a.last_seen) } : null;
}

async function getAgentByApiKey(apiKey) {
  return db.collection('agents').findOne({ api_key: apiKey }, { projection: { _id: 0 } });
}

async function updateAgentLastSeen(agentId) {
  await db.collection('agents').updateOne({ id: agentId }, { $set: { last_seen: new Date().toISOString() } });
}

async function deleteAgent(id, userId) {
  await db.collection('agents').deleteOne({ id, user_id: userId });
}

// ---- Metrics ----
async function insertMetric(metric, agentId = null) {
  try {
    const id = await getNextId('metrics_history');
    await db.collection('metrics_history').insertOne({
      id,
      cpu: metric.cpu ?? 0,
      memory: metric.memory?.usedPercent ?? 0,
      disk_pct: metric.disk?.usePct ?? 0,
      net_rx: metric.network?.rxMbps ?? 0,
      net_tx: metric.network?.txMbps ?? 0,
      timestamp: metric.timestamp ?? new Date().toISOString(),
      agent_id: agentId
    });
    // Keep only last 1000 per agent
    const query = agentId !== null ? { agent_id: agentId } : { agent_id: null };
    const count = await db.collection('metrics_history').countDocuments(query);
    if (count > 1000) {
      const oldest = await db.collection('metrics_history')
        .find(query, { projection: { _id: 1 } })
        .sort({ id: 1 }).limit(count - 1000).toArray();
      await db.collection('metrics_history').deleteMany({ _id: { $in: oldest.map(d => d._id) } });
    }
  } catch (err) {
    console.error('[DB] insertMetric error:', err.message);
  }
}

async function getMetricHistory(limit = 60, agentId = null) {
  const query = agentId !== null ? { agent_id: agentId } : { agent_id: null };
  const results = await db.collection('metrics_history')
    .find(query, { projection: { _id: 0 } })
    .sort({ id: -1 }).limit(limit).toArray();
  return results.reverse();
}

// ---- Logs ----
async function insertLog(log, agentId = null) {
  try {
    const timestamp = log.timestamp ?? new Date().toISOString();
    const level = (log.level ?? 'info').toUpperCase();
    const service = log.service ?? 'system';
    const message = log.message ?? '';
    const id = await getNextId('logs');
    await db.collection('logs').insertOne({ id, timestamp, level, service, message, agent_id: agentId });
    // Keep only last 5000 per agent
    const query = agentId !== null ? { agent_id: agentId } : { agent_id: null };
    const count = await db.collection('logs').countDocuments(query);
    if (count > 5000) {
      const oldest = await db.collection('logs')
        .find(query, { projection: { _id: 1 } })
        .sort({ id: 1 }).limit(count - 5000).toArray();
      await db.collection('logs').deleteMany({ _id: { $in: oldest.map(d => d._id) } });
    }
    return { id, timestamp, level, service, message, agent_id: agentId };
  } catch (err) {
    console.error('[DB] insertLog error:', err.message);
    return log;
  }
}

async function getLogs(limit = 100, level = null, agentId = null) {
  const query = agentId !== null ? { agent_id: agentId } : { agent_id: null };
  if (level && level.toLowerCase() !== 'all') query.level = level.toUpperCase();
  const results = await db.collection('logs')
    .find(query, { projection: { _id: 0 } })
    .sort({ id: -1 }).limit(limit).toArray();
  return results.reverse();
}

// ---- AI Requests ----
async function insertAiRequest({ type, inputTokens, outputTokens, latencyMs, agentId = null }) {
  try {
    const id = await getNextId('ai_requests');
    await db.collection('ai_requests').insertOne({
      id, type,
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      latencyMs: latencyMs || 0,
      agentId,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[DB] insertAiRequest error:', err.message);
  }
}

async function getAiStats() {
  const docs = await db.collection('ai_requests').find({}, { projection: { _id: 0 } }).toArray();
  const totalCalls = docs.length;
  const totalInput = docs.reduce((s, d) => s + (d.inputTokens || 0), 0);
  const totalOutput = docs.reduce((s, d) => s + (d.outputTokens || 0), 0);
  const avgLatencyMs = totalCalls > 0
    ? Math.round(docs.reduce((s, d) => s + (d.latencyMs || 0), 0) / totalCalls)
    : 0;
  // claude-sonnet-4: $3/MTok input, $15/MTok output
  const estimatedCostUsd = parseFloat(((totalInput * 3 + totalOutput * 15) / 1_000_000).toFixed(4));
  const recent = docs.slice(-20).reverse();
  return { totalCalls, totalInput, totalOutput, avgLatencyMs, estimatedCostUsd, recent };
}

module.exports = {
  initDB,
  createUser, getUserById, getUserByGoogleId, getUserByStripeCustomer, updateUserPlan,
  createAgent, getAgentsByUserId, getAgentById, getAgentByApiKey,
  updateAgentLastSeen, deleteAgent, getAgentStatus,
  insertMetric, getMetricHistory,
  insertLog, getLogs,
  insertAiRequest, getAiStats
};
