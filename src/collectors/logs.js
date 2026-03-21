const EventEmitter = require('events');
const path = require('path');

let chokidar;
try {
  chokidar = require('chokidar');
} catch {
  chokidar = null;
}

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

const LOG_DIR = process.env.LOG_DIR || '/var/log';

function detectLevel(line) {
  const upper = line.toUpperCase();
  if (upper.includes('ERROR') || upper.includes('FATAL') || upper.includes('CRITICAL')) return 'ERROR';
  if (upper.includes('WARN') || upper.includes('WARNING')) return 'WARN';
  if (upper.includes('DEBUG') || upper.includes('TRACE')) return 'DEBUG';
  return 'INFO';
}

function detectService(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base || 'system';
}

function parseLine(line, filePath) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return {
    timestamp: new Date().toISOString(),
    level: detectLevel(trimmed),
    service: detectService(filePath),
    message: trimmed.substring(0, 500)
  };
}

function startLogWatcher() {
  if (!chokidar) {
    console.warn('[LogCollector] chokidar not available, file watching disabled');
    return;
  }

  try {
    const fs = require('fs');
    if (!fs.existsSync(LOG_DIR)) {
      console.warn('[LogCollector] Log directory not accessible:', LOG_DIR);
      return;
    }

    const watcher = chokidar.watch(`${LOG_DIR}/*.log`, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 }
    });

    watcher.on('change', (filePath) => {
      try {
        const fs = require('fs');
        const stat = fs.statSync(filePath);
        const size = stat.size;
        const readSize = Math.min(2048, size);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buf, 0, readSize, Math.max(0, size - readSize));
        fs.closeSync(fd);

        const text = buf.toString('utf8');
        const lines = text.split('\n').filter(l => l.trim());
        const last = lines[lines.length - 1];
        if (last) {
          const parsed = parseLine(last, filePath);
          if (parsed) logEmitter.emit('log', parsed);
        }
      } catch {
        // ignore file read errors
      }
    });

    watcher.on('error', (err) => {
      console.warn('[LogCollector] Watcher error:', err.message);
    });

    console.log('[LogCollector] Watching', LOG_DIR);
  } catch (err) {
    console.warn('[LogCollector] Could not start watcher:', err.message);
  }
}

function emitAppLog(level, service, message) {
  const log = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    service,
    message
  };
  logEmitter.emit('log', log);
  return log;
}

module.exports = { logEmitter, startLogWatcher, emitAppLog, parseLine };
