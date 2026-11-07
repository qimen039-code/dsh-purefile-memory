#!/usr/bin/env node
// LoCoMo bench 桥接服务：把评测 harness 的 ingest/recall 请求接到已部署的记忆系统。
//
//   node dshmem_bridge.mjs --config ./config.json --port 0
//
// API（JSON over HTTP）：
//   GET  /health                     → {ok, facts, records, semantic}
//   POST /ingest {id, dialog}        → {record_id, facts, reused, extraction}
//   POST /recall {query, dialog_id?, k?, semantic?}
//                                    → {snippets: [...], abstained, candidates, took_ms}
// API key 一律从环境变量读（config.semantic.apiKeyEnv），不落盘、不回显。

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../memory/system/lib/store.mjs';
import { allFacts, recallFacts } from '../memory/system/lib/facts.mjs';
import { ingestDialog } from '../memory/system/lib/dialog.mjs';
import { semanticConfig } from '../memory/system/lib/semantic.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { config: path.join(HERE, 'config.json'), port: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--config') args.config = path.resolve(HERE, argv[++i]);
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
  }
  return args;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig({ configPath: args.config });
  const sem = semanticConfig(cfg);
  const semanticReady = sem.enabled;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const facts = allFacts(cfg);
        sendJson(res, 200, {
          ok: true,
          records: true,
          facts: facts.length,
          semantic: semanticReady,
          model: sem.model || null,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/ingest') {
        const body = await readBody(req);
        const dialog = body.dialog?.conversation ? body.dialog : { sample_id: body.id, conversation: body.dialog };
        const result = await ingestDialog(cfg, dialog, {
          id: body.id || null,
          noLlm: body.no_llm === true,
          force: body.force === true,
          workspace: 'bench',
        });
        sendJson(res, 200, {
          ok: true,
          record_id: result.id,
          facts: result.facts,
          reused: result.reused,
          extraction: result.extraction ?? null,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/recall') {
        const body = await readBody(req);
        const result = await recallFacts(cfg, {
          query: body.query,
          k: body.k ?? 4,
          semantic: body.semantic !== false && semanticReady,
          dialogId: body.dialog_id ?? null,
        });
        // snippets 已含【相关记忆整合】摘要行（若产出）+ top-k 事实行。
        sendJson(res, 200, {
          snippets: result.snippets ?? result.items.map((item) => item.snippet),
          abstained: result.abstained,
          candidates: result.candidates,
          items: result.items,
          digest: result.digest ?? null,
          took_ms: result.took_ms,
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: `unknown path ${url.pathname}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) });
    }
  });

  await new Promise((resolve) => server.listen(args.port, '127.0.0.1', resolve));
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ ok: true, port: address.port, semantic: semanticReady })}\n`);
}

main().catch((error) => {
  process.stderr.write(`bridge error: ${error?.stack || error}\n`);
  process.exit(1);
});
