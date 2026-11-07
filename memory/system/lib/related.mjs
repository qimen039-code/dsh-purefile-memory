import { indexFileFor, isIndexFresh, searchFts } from './fts.mjs';
import { normKey, queryTerms, termsOf } from './util.mjs';

/**
 * Read-only "what might this be a duplicate/conflict of?" lookup.
 * It never writes or changes standing; the caller decides annotate/supersede/link.
 */
export function similarRecords(cfg, {
  title = '',
  gist = '',
  query = '',
  workspace = cfg.defaultWorkspace,
  k = 5,
  excludeId = null,
  allWorkspaces = false,
  minCoverage = 0.3,
} = {}) {
  const text = String(query || `${title} ${gist}`).trim();
  if (!text) return { available: false, reason: 'empty-query', results: [] };
  if (!isIndexFresh(cfg)) return { available: false, reason: 'index-stale', results: [] };

  const search = searchFts(indexFileFor(cfg), text, {
    limit: 100,
    workspace,
    allWorkspaces,
    history: false,
    includeSealed: true,
    allowSensitive: false,
  });
  const queryTermSet = new Set(queryTerms(text).strong);
  const results = [];
  const seen = new Set();
  for (const row of search.results) {
    if (row.id === excludeId || seen.has(row.id)) continue;
    let record;
    try {
      record = JSON.parse(row.doc_json);
    } catch {
      continue;
    }
    if (record.standing !== 'current') continue;
    if (record.temperature === 'frozen') continue;
    if (record.privacy?.sensitive) continue;
    if (!allWorkspaces && record.scope !== 'global' && normKey(record.workspace) !== normKey(workspace)) continue;
    const recordTerms = new Set(termsOf([
      record.title ?? '',
      record.gist ?? '',
      ...(record.aliases ?? []),
      ...(record.key_points ?? []),
    ].join(' ')));
    let shared = 0;
    for (const term of queryTermSet) if (recordTerms.has(term)) shared += 1;
    const coverage = queryTermSet.size === 0 ? 0 : shared / queryTermSet.size;
    if (coverage < minCoverage) continue;
    seen.add(row.id);
    results.push({
      id: record.id,
      title: record.title,
      gist: record.gist,
      kind: record.kind,
      temperature: record.temperature,
      workspace: record.workspace,
      coverage: +coverage.toFixed(3),
      rank: results.length + 1,
      next: `mem route ${record.id} --layer l1`,
    });
    if (results.length >= k) break;
  }
  return { available: true, query: text, results };
}
