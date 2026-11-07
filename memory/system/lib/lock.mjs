import fs from 'node:fs';
import path from 'node:path';
import { MemError, ensureDir, nowIso } from './util.mjs';

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

export function withFileLock(lockFile, fn, { timeoutMs = 10_000, staleMs = 30_000, retryMs = 20 } = {}) {
  ensureDir(path.dirname(lockFile));
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      fs.closeSync(fd);
      fd = -1;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new MemError(`等待写锁超时：${lockFile}`, 'LOCK_TIMEOUT', { lockFile, timeoutMs });
      }
      sleep(retryMs);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function lockFileFor(dir) {
  return path.join(dir, '.write.lock');
}
