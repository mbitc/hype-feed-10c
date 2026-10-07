import 'dotenv/config';
import Parser from 'rss-parser';
import { writeFileSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { classifyBatch } from './classifier.js';

const TZ = process.env.FEED_TZ || 'Europe/Vilnius';
const ITEMS_PER_SOURCE = 10;
const DOCS_DIR = 'docs';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'HypeFeed10c/1.0 (calm-news-aggregator)' }
});

const SOURCES = [
  { name: 'BBC World',      url: 'https://feeds.bbci.co.uk/news/world/rss.xml', region: 'UK' },
  { name: 'Deutsche Welle', url: 'https://rss.dw.com/rdf/rss-en-all',           region: 'Germany' },
  { name: 'France 24',      url: 'https://www.france24.com/en/rss',             region: 'France' },
  { name: 'The Guardian',   url: 'https://www.theguardian.com/world/rss',       region: 'UK' },
  { name: 'Al Jazeera',     url: 'https://www.aljazeera.com/xml/rss/all.xml',   region: 'Qatar' },
  { name: 'Japan Today',    url: 'https://japantoday.com/feed',                 region: 'Japan' },
  { name: 'Global News',    url: 'https://globalnews.ca/feed/',                 region: 'Canada' }
];

const STOP = new Set(`that this with from have after over says said will into about their been were what more than
  when where which while amid between against during under`.split(/\s+/));

function titleTokens(title) {
  return new Set((title.toLowerCase().match(/[a-z]+|\d+/g) || []).filter((w) => /\d/.test(w) || (w.length > 3 && !STOP.has(w))));
}

function sameEvent(a, b) {
  if (a.size < 3 || b.size < 3) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared >= 3 && shared / Math.min(a.size, b.size) >= 0.5;
}

async function fetchAll() {
  const results = await Promise.allSettled(SOURCES.map((s) => parser.parseURL(s.url)));
  const articles = [];

  results.forEach((res, i) => {
    const source = SOURCES[i];
    if (res.status === 'rejected') {
      console.error(`[fetch] ${source.name} failed: ${res.reason?.message}`);
      return;
    }
    for (const item of res.value.items.slice(0, ITEMS_PER_SOURCE)) {
      if (!item.title || !item.link) continue;
      articles.push({
        title: item.title.trim(),
        link: item.link,
        contentSnippet: item.contentSnippet || '',
        source
      });
    }
  });

  return articles;
}

function cluster(articles, classified) {
  const raw = articles.map((a, idx) => ({
    title: a.title, link: a.link, source: a.source, scores: classified[idx]
  }));

  const clusters = [];
  for (const item of raw) {
    const toks = titleTokens(item.title);
    const cluster = clusters.find((c) => c.tokenSets.some((t) => sameEvent(t, toks)));

    if (!cluster) {
      clusters.push({
        title: item.title, link: item.link,
        sources: [{ name: item.source.name, region: item.source.region }],
        tokenSets: [toks], scoreList: [item.scores]
      });
    } else if (!cluster.sources.some((s) => s.name === item.source.name)) {
      cluster.sources.push({ name: item.source.name, region: item.source.region });
      cluster.tokenSets.push(toks);
      cluster.scoreList.push(item.scores);
    }
  }

  const avg = (list, k) => parseFloat((list.reduce((a, s) => a + s[k], 0) / list.length).toFixed(2));
  return clusters.map((c) => ({
    title: c.title, link: c.link, sources: c.sources, matchCount: c.sources.length,
    scores: {
      intention: avg(c.scoreList, 'intention'),
      intensity: avg(c.scoreList, 'intensity'),
      load: avg(c.scoreList, 'load'),
      confidence: avg(c.scoreList, 'confidence'),
      via: [...new Set(c.scoreList.map((s) => s.source))].join('+')
    }
  }));
}

function calculatePulse(items) {
  const charged = items.filter((i) => i.scores.intention !== 0);
  if (charged.length === 0) return { pulse: 0, peak: 0, peakLabel: 'QUIET' };
  const pulse = charged.reduce((a, i) => a + i.scores.load, 0) / charged.length;
  const peak = charged.reduce((m, i) => (Math.abs(i.scores.load) > Math.abs(m) ? i.scores.load : m), 0);
  const abs = Math.abs(peak);
  const peakLabel = abs > 0.7 ? 'ELEVATED' : abs > 0.4 ? 'ACTIVE' : 'QUIET';
  return { pulse: parseFloat(pulse.toFixed(2)), peak: parseFloat(peak.toFixed(2)), peakLabel };
}

const MAX_HEAVY = 1;
const isHeavy = (i) => i.scores.load < -0.5;
function weight(i) {
  return Math.log2(1 + i.matchCount) * 2 + Math.min(i.scores.intensity, 3) * 0.3 - Math.abs(i.scores.load) * 1.5;
}

function selectMainFacts(items, count = 3) {
  const sorted = [...items].sort((a, b) => weight(b) - weight(a));
  const regions = new Set();
  const result = [];
  let heavy = 0;
  for (const item of sorted) {
    const region = item.sources[0].region;
    if (regions.has(region)) continue;
    if (isHeavy(item) && heavy >= MAX_HEAVY) continue;
    regions.add(region);
    if (isHeavy(item)) heavy++;
    result.push(item);
    if (result.length >= count) break;
  }
  return result;
}

function selectBalancing(items, exclude, count = 2) {
  return items
    .filter((i) => !exclude.includes(i) && i.scores.intention >= 0.3 && i.scores.intensity > 0.5)
    .sort((a, b) => b.matchCount - a.matchCount || b.scores.load - a.scores.load)
    .slice(0, count);
}

// --- Render (reuse from index.js, adapt to write to file) ---
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? esc(u) : '#');
const sign = (n) => (n > 0 ? '+' : '') + n;

function renderItem(item, { numbered, index, meta, tagClass }) {
  return `
        <div class="feed-item">
          <a href="${safeUrl(item.link)}" target="_blank" rel="noopener noreferrer" class="feed-title">
            ${numbered ? `[${index + 1}] ` : ''}${esc(item.title)}
            <span class="load-tag ${tagClass}">${sign(item.scores.load)}</span>
          </a>
          <div class="feed-meta">${esc(meta)}</div>
        </div>`;
}

function renderPage({ mainFacts, balancing, pulse, builtAt }) {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(builtAt);

  const factsHtml = mainFacts.length
    ? mainFacts.map((item, i) => renderItem(item, {
        numbered: true, index: i,
        meta: `Sources (${item.matchCount}): ${item.sources.map((s) => s.name).join(' · ')}`,
        tagClass: item.scores.load < -0.4 ? 'neg' : item.scores.load > 0.4 ? 'pos' : 'neu'
      })).join('')
    : `<div class="feed-item"><div class="feed-title">No notable events in this cycle.</div></div>`;

  const balancingHtml = balancing.length
    ? balancing.map((item) => renderItem(item, {
        numbered: false,
        meta: `Source: ${item.sources[0].name} · Region: ${item.sources[0].region}`,
        tagClass: 'pos'
      })).join('')
    : `<div class="feed-item"><div class="feed-title">No balancing signals in this cycle.</div></div>`;

  const badge = pulse.peakLabel === 'ELEVATED' ? 'elevated' : pulse.peakLabel === 'ACTIVE' ? 'active' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="1800">
<title>Hype Feed 10c — World Pulse</title>
<style>
  :root {
    --bg: #0f1115; --card: #161922; --text: #e2e8f0; --muted: #8a99ad;
    --accent: #38bdf8; --active: #f59e0b; --elevated: #b45309; --border: #2a3241;
    --neg: #c2410c; --pos: #16a34a;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh; padding: 20px;
  }
  .container {
    width: 100%; max-width: 720px; background: var(--card);
    border: 1px solid var(--border); border-radius: 8px;
    padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  h1 { font-size: 1.2rem; letter-spacing: -0.5px; }
  .pulse-badge { font-size: 0.85rem; background: rgba(56,189,248,0.1); color: var(--accent); padding: 4px 10px; border-radius: 4px; border: 1px solid rgba(56,189,248,0.2); }
  .pulse-badge.active { background: rgba(245,158,11,0.1); color: var(--active); border-color: rgba(245,158,11,0.2); }
  .pulse-badge.elevated { background: rgba(180,83,9,0.12); color: var(--elevated); border-color: rgba(180,83,9,0.3); }
  section { margin-bottom: 28px; }
  h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 12px; }
  .feed-item { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px dashed var(--border); }
  .feed-item:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
  .feed-title { font-size: 0.95rem; line-height: 1.4; color: var(--text); text-decoration: none; display: block; margin-bottom: 4px; }
  .feed-title:hover { color: var(--accent); }
  .feed-meta { font-size: 0.75rem; color: var(--muted); }
  .load-tag { font-size: 0.7rem; border: 1px solid var(--muted); border-radius: 3px; padding: 1px 6px; margin-left: 6px; vertical-align: middle; }
  .load-tag.neg { color: var(--neg); border-color: var(--neg); }
  .load-tag.pos { color: var(--pos); border-color: var(--pos); }
  .load-tag.neu { color: var(--muted); }
  footer { border-top: 1px solid var(--border); padding-top: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
  .footer-note { font-size: 0.75rem; color: var(--muted); }
</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>☕ HYPE FEED 10C</h1>
      <div class="pulse-badge ${badge}">Pulse: ${pulse.pulse} · Peak: ${pulse.peak} (${pulse.peakLabel})</div>
    </header>
    <section>
      <h2>1. Main facts (cross-confirmed, low emotional load first)</h2>
      ${factsHtml}
    </section>
    <section>
      <h2>2. Balancing signals (positive load)</h2>
      ${balancingHtml}
    </section>
    <footer>
      <div class="footer-note">Updated ${esc(when)} · Next cycle 08:00 / 18:00</div>
    </footer>
  </div>
</body>
</html>`;
}

function logCycleJson(items, pulse, mainFacts, balancing, classStats, cycleMs) {
  const record = {
    ts: new Date().toISOString(),
    pulse: pulse.pulse,
    peak: pulse.peak,
    peakLabel: pulse.peakLabel,
    total: items.length,
    classification: { ...classStats, cycleMs },
    mainFacts: mainFacts.map((i) => ({ load: i.scores.load, via: i.scores.via, confidence: i.scores.confidence, title: i.title, sources: i.sources.map((s) => s.name) })),
    balancing: balancing.map((i) => ({ load: i.scores.load, via: i.scores.via, confidence: i.scores.confidence, title: i.title }))
  };
  appendFileSync(`${DOCS_DIR}/cycles.jsonl`, JSON.stringify(record) + '\n');
}

async function main() {
  const t0 = Date.now();
  console.log(`[start] ${new Date().toISOString()}`);

  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });

  const articles = await fetchAll();
  console.log(`[fetch] ${articles.length} headlines from ${SOURCES.length} sources`);

  if (articles.length === 0) {
    console.error('[abort] no articles fetched');
    process.exit(1);
  }

  const { results: classified, stats: classStats } = await classifyBatch(articles);
  console.log(`[class] cache=${classStats.cache} gemini=${classStats.gemini} fallback=${classStats.fallback} | api_calls=${classStats.apiCalls} retries=${classStats.retries} errors=${classStats.errors} | classify=${(classStats.ms/1000).toFixed(1)}s`);

  const items = cluster(articles, classified);
  const pulse = calculatePulse(items);
  const mainFacts = selectMainFacts(items, 3);
  const balancing = selectBalancing(items, mainFacts, 2);

  const cycleMs = Date.now() - t0;
  console.log(`[cycle] total=${items.length} pulse=${pulse.pulse} peak=${pulse.peak} (${pulse.peakLabel}) | cycle=${(cycleMs/1000).toFixed(1)}s`);

  const html = renderPage({ mainFacts, balancing, pulse, builtAt: new Date() });
  writeFileSync(`${DOCS_DIR}/index.html`, html);
  logCycleJson(items, pulse, mainFacts, balancing, classStats, cycleMs);

  console.log(`[done] wrote ${DOCS_DIR}/index.html and appended to ${DOCS_DIR}/cycles.jsonl`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
