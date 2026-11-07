import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

export class MemError extends Error {
  constructor(message, code = 'MEM_ERROR', detail = undefined) {
    super(message);
    this.name = 'MemError';
    this.code = code;
    this.detail = detail;
  }
}

export function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

export function nowIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function dateStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function timeStamp(date = new Date()) {
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function newId(prefix = 'rec', date = new Date()) {
  return `${prefix}-${dateStamp(date)}-${timeStamp(date)}-${crypto.randomBytes(2).toString('hex')}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (fallback !== null && fallback !== undefined && error && error.code === 'ENOENT') return fallback;
    throw new MemError(`无法读取 JSON：${file}：${error.message}`, 'READ_JSON_FAILED', { file });
  }
}

export function writeJson(file, value, { indent = 2 } = {}) {
  atomicWrite(file, `${JSON.stringify(value, null, indent)}\n`);
}

export function atomicWrite(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    // Windows can refuse rename over an existing read-only file; fall back to
    // remove+rename. The temp file still prevents a partial write.
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } catch (inner) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw new MemError(`原子写入失败：${file}：${inner.message}`, 'WRITE_FAILED', { file });
    }
  }
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function readJsonl(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try { return JSON.parse(line); } catch { return { _raw: line }; }
      });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function shortHash(value, length = 10) {
  return sha256(value).slice(0, length);
}

export function normKey(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function samePath(a, b) {
  return normKey(a) === normKey(b);
}

export function workspaceKey(cwd) {
  const raw = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const key = raw
    .replace(/^([A-Za-z]):/, '$1')
    .replace(/[^A-Za-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return key || 'unknown-workspace';
}

export function slugify(value, max = 64) {
  const slug = String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'note').slice(0, max);
}

export function truncate(value, max = 200, suffix = '…') {
  const text = String(value ?? '');
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - suffix.length)).join('') + suffix;
}

export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeCell(value, max = 120) {
  return truncate(String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '), max);
}

export function parseDate(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function daysSince(value, now = Date.now()) {
  const ms = parseDate(value);
  if (ms === null) return Infinity;
  return (now - ms) / 86_400_000;
}

export function isRecent(value, days, now = Date.now()) {
  return daysSince(value, now) <= days;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function parseArgs(argv) {
  const list = [...argv];
  const flags = {};
  const positionals = [];
  let command = null;
  let i = 0;

  const setFlag = (name, value) => {
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      const previous = flags[name];
      flags[name] = Array.isArray(previous) ? [...previous, value] : [previous, value];
    } else {
      flags[name] = value;
    }
  };

  if (list.length > 0 && !list[0].startsWith('-')) {
    command = list[0];
    i = 1;
  }

  for (; i < list.length; i += 1) {
    const item = list[i];
    if (item === '--') {
      positionals.push(...list.slice(i + 1));
      break;
    }
    if (item.startsWith('--')) {
      const eq = item.indexOf('=');
      if (eq !== -1) {
        setFlag(item.slice(2, eq), item.slice(eq + 1));
        continue;
      }
      const name = item.slice(2);
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        setFlag(name, next);
        i += 1;
      } else {
        setFlag(name, true);
      }
      continue;
    }
    if (item.startsWith('-') && item.length > 1 && !/^-\d/.test(item)) {
      const name = item.slice(1);
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        setFlag(name, next);
        i += 1;
      } else {
        setFlag(name, true);
      }
      continue;
    }
    positionals.push(item);
  }

  return { command, flags, positionals };
}

export function flag(flags, name, fallback = undefined) {
  const value = flags[name];
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  return value;
}

export function flagList(flags, name) {
  const value = flags[name];
  if (value === undefined || value === false) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function boolFlag(flags, name, fallback = false) {
  if (!(name in flags)) return fallback;
  const value = flags[name];
  if (value === true || value === false) return value;
  return !/^(0|false|no|off)$/i.test(String(value));
}

export function numberFlag(flags, name, fallback) {
  const value = flags[name];
  if (value === undefined || value === true || value === false) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function termsOf(text, { includeSingleCjk = false } = {}) {
  const source = String(text ?? '').toLowerCase();
  const tokens = new Set();
  const latin = source.match(/[a-z0-9][a-z0-9_./:@#+-]*/g) ?? [];
  for (const token of latin) {
    if (token.length >= 2) tokens.add(token);
  }
  const runs = source.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of runs) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i += 1) {
      if (includeSingleCjk && chars.length === 1) tokens.add(chars[i]);
      if (i + 1 < chars.length) tokens.add(chars[i] + chars[i + 1]);
      if (i + 2 < chars.length) tokens.add(chars[i] + chars[i + 1] + chars[i + 2]);
    }
  }
  return [...tokens];
}

export function queryTerms(text) {
  const all = termsOf(text, { includeSingleCjk: true });
  const strong = all.filter((token) => token.length >= 2);
  return {
    all,
    strong: strong.length > 0 ? strong : all,
  };
}

export function scoreFields(query, fields) {
  const { all, strong } = query;
  let score = 0;
  let strongHits = 0;
  const reasons = [];
  for (const token of all) {
    let hit = 0;
    for (const field of fields) {
      if (!field.text) continue;
      if (field.text.includes(token)) hit += field.weight;
    }
    if (hit > 0) {
      score += hit;
      if (strong.includes(token)) strongHits += 1;
    }
  }
  if (strongHits === 0) return { score: 0, reasons: [], strongHits: 0, strongTotal: strong.length };
  if (strongHits > 0) reasons.push(`${strongHits} term(s)`);
  return { score, reasons, strongHits, strongTotal: strong.length };
}

export function findZstd(config = {}) {
  const candidates = [];
  if (config.zstd && config.zstd !== 'auto') candidates.push(config.zstd);
  if (process.env.MEM_ZSTD) candidates.push(process.env.MEM_ZSTD);
  const pathDirs = String(process.env.PATH ?? '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'zstd.exe'));
    candidates.push(path.join(dir, 'zstd'));
  }
  candidates.push('D:/AI/mingw64/bin/zstd.exe');
  candidates.push('/usr/local/bin/zstd');
  candidates.push('/usr/bin/zstd');
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

export function zstdDecompress(file, zstdPath) {
  if (!zstdPath) {
    throw new MemError(
      '找不到 zstd 可执行文件。安装 zstd 或设置 MEM_ZSTD / config.zstd 后重试。',
      'ZSTD_NOT_FOUND',
      { file },
    );
  }
  const result = spawnSync(zstdPath, ['-dc', '--', file], {
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new MemError(`zstd 解压失败：${result.error.message}`, 'ZSTD_FAILED', { file });
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf8') : '';
    throw new MemError(`zstd 解压失败（exit ${result.status}）：${truncate(stderr, 400)}`, 'ZSTD_FAILED', { file });
  }
  return result.stdout.toString('utf8');
}

export function zstdFirstFrame(file) {
  // Node's zstd decoder stops after the first frame, which is exactly the
  // session header in DSH's concatenated-frame JSONL. This keeps indexing fast.
  try {
    const buffer = fs.readFileSync(file);
    const text = zlib.zstdDecompressSync(buffer).toString('utf8');
    return text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  } catch {
    return '';
  }
}

export function walkDirs(root, predicate = () => true) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(root, entry.name);
    if (predicate(full, entry.name)) found.push(full);
    found.push(...walkDirs(full, predicate));
  }
  return found;
}

export function relativeDisplay(root, target) {
  const rel = path.relative(root, target);
  return rel.split(path.sep).join('/');
}

export function resolveInside(root, relative) {
  const full = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new MemError(`路径越界：${relative}`, 'PATH_ESCAPE');
  }
  return full;
}

export function isoDay(iso) {
  return String(iso ?? '').slice(0, 10);
}

export function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
