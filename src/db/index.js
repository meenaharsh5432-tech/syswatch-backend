const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/syswatch.db');

let db = null;

function queryAll(sql, params = []) {
  if (!db) return [];
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (err) {
    console.error('[DB] queryAll error:', err.message, '|', sql);
    return [];
  }
}

function queryOne(sql, params = []) {
  return queryAll(sql, params)[0] || null;
}

function run(sql, params = []) {
  if (!db) return;
  try {
    db.run(sql, params);
  } catch (err) {
    console.error('[DB] run error:', err.message, '|', sql);
  }
}

function columnExists(table, column) {
  const cols = queryAll(`PRAGMA table_info(${table})`);
  return cols.some(c => c.name === column);
}

function saveDB() {
  if (!db) return;
  try {
    const data = db.export();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('[DB] Save error:', err.message);
  }
}

async function initDB() {
  try {
    const SQL = await require('sql.js')();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(DB_PATH)) {
      db = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      db = new SQL.Database();
    }

    // Base tables
    db.run(`
      CREATE TABLE IF NOT EXISTS metrics_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cpu REAL, memory REAL, disk_pct REAL, net_rx REAL, net_tx REAL,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL, level TEXT NOT NULL,
        service TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT, avatar TEXT, google_id TEXT UNIQUE,
        plan TEXT DEFAULT 'free',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        api_key TEXT UNIQUE NOT NULL,
        last_seen TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);

    // Migrations — add agent_id to existing tables
    if (!columnExists('metrics_history', 'agent_id')) {
      db.run('ALTER TABLE metrics_history ADD COLUMN agent_id INTEGER');
    }
    if (!columnExists('logs', 'agent_id')) {
      db.run('ALTER TABLE logs ADD COLUMN agent_id INTEGER');
    }

    // Indexes
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_history(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_agent ON metrics_history(agent_id);
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
      CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agents_key ON agents(api_key);
      CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
    `);

    setInterval(saveDB, 30000);
    console.log('[DB] Initialized at', DB_PATH);
  } catch (err) {
    console.error('[DB] Init failed:', err.message);
  }
}

// ---- Users ----
function createUser({ email, name, avatar, google_id }) {
  run('INSERT OR IGNORE INTO users (email, name, avatar, google_id) VALUES (?, ?, ?, ?)',
    [email, name || null, avatar || null, google_id || null]);
  return queryOne('SELECT * FROM users WHERE email = ?', [email]);
}

function getUserById(id) {
  return queryOne('SELECT * FROM users WHERE id = ?', [id]);
}

function getUserByGoogleId(googleId) {
  return queryOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
}

function getUserByStripeCustomer(customerId) {
  return queryOne('SELECT * FROM users WHERE stripe_customer_id = ?', [customerId]);
}

function updateUserPlan(userId, plan, stripeCustomerId = null, stripeSubId = null) {
  run(
    'UPDATE users SET plan = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?',
    [plan, stripeCustomerId, stripeSubId, userId]
  );
}

// ---- Agents ----
function getAgentStatus(lastSeen) {
  if (!lastSeen) return 'offline';
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  if (diffMs < 30000) return 'online';
  if (diffMs < 120000) return 'degraded';
  return 'offline';
}

function createAgent(userId, name) {
  const apiKey = 'sk-agent-' + crypto.randomBytes(24).toString('hex');
  run('INSERT INTO agents (user_id, name, api_key) VALUES (?, ?, ?)', [userId, name, apiKey]);
  const agent = queryOne('SELECT * FROM agents WHERE api_key = ?', [apiKey]);
  return agent;
}

function getAgentsByUserId(userId) {
  return queryAll('SELECT * FROM agents WHERE user_id = ?', [userId])
    .map(a => ({ ...a, status: getAgentStatus(a.last_seen) }));
}

function getAgentById(id) {
  const a = queryOne('SELECT * FROM agents WHERE id = ?', [id]);
  return a ? { ...a, status: getAgentStatus(a.last_seen) } : null;
}

function getAgentByApiKey(apiKey) {
  return queryOne('SELECT * FROM agents WHERE api_key = ?', [apiKey]);
}

function updateAgentLastSeen(agentId) {
  run('UPDATE agents SET last_seen = ? WHERE id = ?', [new Date().toISOString(), agentId]);
}

function deleteAgent(id, userId) {
  run('DELETE FROM agents WHERE id = ? AND user_id = ?', [id, userId]);
}

// ---- Metrics ----
function insertMetric(metric, agentId = null) {
  if (!db) return;
  try {
    db.run(
      'INSERT INTO metrics_history (cpu, memory, disk_pct, net_rx, net_tx, timestamp, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        metric.cpu ?? 0,
        metric.memory?.usedPercent ?? 0,
        metric.disk?.usePct ?? 0,
        metric.network?.rxMbps ?? 0,
        metric.network?.txMbps ?? 0,
        metric.timestamp ?? new Date().toISOString(),
        agentId
      ]
    );
    if (agentId) {
      db.run('DELETE FROM metrics_history WHERE agent_id = ? AND id NOT IN (SELECT id FROM metrics_history WHERE agent_id = ? ORDER BY id DESC LIMIT 1000)', [agentId, agentId]);
    } else {
      db.run('DELETE FROM metrics_history WHERE agent_id IS NULL AND id NOT IN (SELECT id FROM metrics_history WHERE agent_id IS NULL ORDER BY id DESC LIMIT 1000)');
    }
  } catch (err) {
    console.error('[DB] insertMetric error:', err.message);
  }
}

function getMetricHistory(limit = 60, agentId = null) {
  let sql, params;
  if (agentId) {
    sql = 'SELECT * FROM metrics_history WHERE agent_id = ? ORDER BY id DESC LIMIT ?';
    params = [agentId, limit];
  } else {
    sql = 'SELECT * FROM metrics_history WHERE agent_id IS NULL ORDER BY id DESC LIMIT ?';
    params = [limit];
  }
  return queryAll(sql, params).reverse();
}

// ---- Logs ----
function insertLog(log, agentId = null) {
  if (!db) return log;
  try {
    const timestamp = log.timestamp ?? new Date().toISOString();
    const level = (log.level ?? 'info').toUpperCase();
    const service = log.service ?? 'system';
    const message = log.message ?? '';
    db.run(
      'INSERT INTO logs (timestamp, level, service, message, agent_id) VALUES (?, ?, ?, ?, ?)',
      [timestamp, level, service, message, agentId]
    );
    const idRow = queryOne('SELECT last_insert_rowid() as id');
    const id = idRow?.id ?? null;
    if (agentId) {
      db.run('DELETE FROM logs WHERE agent_id = ? AND id NOT IN (SELECT id FROM logs WHERE agent_id = ? ORDER BY id DESC LIMIT 5000)', [agentId, agentId]);
    } else {
      db.run('DELETE FROM logs WHERE agent_id IS NULL AND id NOT IN (SELECT id FROM logs WHERE agent_id IS NULL ORDER BY id DESC LIMIT 5000)');
    }
    return { ...log, id, timestamp, level, service, message };
  } catch (err) {
    console.error('[DB] insertLog error:', err.message);
    return log;
  }
}

function getLogs(limit = 100, level = null, agentId = null) {
  const whereAgent = agentId ? 'agent_id = ?' : 'agent_id IS NULL';
  const agentParam = agentId ? [agentId] : [];
  let sql, params;
  if (level && level.toLowerCase() !== 'all') {
    sql = `SELECT * FROM logs WHERE ${whereAgent} AND level = ? ORDER BY id DESC LIMIT ?`;
    params = [...agentParam, level.toUpperCase(), limit];
  } else {
    sql = `SELECT * FROM logs WHERE ${whereAgent} ORDER BY id DESC LIMIT ?`;
    params = [...agentParam, limit];
  }
  return queryAll(sql, params).reverse();
}

module.exports = {
  initDB, saveDB,
  createUser, getUserById, getUserByGoogleId, getUserByStripeCustomer, updateUserPlan,
  createAgent, getAgentsByUserId, getAgentById, getAgentByApiKey,
  updateAgentLastSeen, deleteAgent, getAgentStatus,
  insertMetric, getMetricHistory,
  insertLog, getLogs
};
