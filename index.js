import express from 'express';
import Parser from 'rss-parser';
import { logCycle, logCycleJson } from './logger.js';
import 'dotenv/config';
import { classifyBatch } from './classifier.js';

const PORT = process.env.PORT || 3000;
const TZ = process.env.FEED_TZ || 'Europe/Vilnius';
const ITEMS_PER_SOURCE = 10;
const RETRY_MS = 10 * 60 * 1000;

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'HypeFeed10c/1.1 (calm-news-aggregator)' }
});

// ---------------------------------------------------------------------------
// SOURCES
// ---------------------------------------------------------------------------
const SOURCES = [
  { name: 'BBC World',      url: 'https://feeds.bbci.co.uk/news/world/rss.xml', region: 'UK' },
  { name: 'Deutsche Welle', url: 'https://rss.dw.com/rdf/rss-en-all',           region: 'Germany' },
  { name: 'France 24',      url: 'https://www.france24.com/en/rss',             region: 'France' },
  { name: 'The Guardian',   url: 'https://www.theguardian.com/world/rss',       region: 'UK' },
  { name: 'Al Jazeera',     url: 'https://www.aljazeera.com/xml/rss/all.xml',   region: 'Qatar' },
  { name: 'Japan Today',    url: 'https://japantoday.com/feed',                 region: 'Japan' },
  { name: 'Global News',    url: 'https://globalnews.ca/feed/',                 region: 'Canada' }
];

// ---------------------------------------------------------------------------
// SAME-EVENT DETECTION — shared significant words/numbers, overlap coefficient
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// FETCH & CLUSTER (VIENINTELĖ versija — su classifyBatch)
// ---------------------------------------------------------------------------
async function fetchAllArticles() {
  const results = await Promise.allSettled(SOURCES.map((s) => parser.parseURL(s.url)));
  const rawArticles = [];

  results.forEach((res, i) => {
    const source = SOURCES[i];
    if (res.status === 'rejected') {
      console.error(`[fetch] ${source.name} failed: ${res.reason?.message}`);
      return;
    }
    for (const item of res.value.items.slice(0, ITEMS_PER_SOURCE)) {
      if (!item.title || !item.link) continue;
      rawArticles.push({
        title: item.title.trim(),
        link: item.link,
        contentSnippet: item.contentSnippet || '',
        source
      });
    }
  });

  const { results: classified, stats: classStats } = await classifyBatch(rawArticles);

  const raw = rawArticles.map((article, idx) => ({
    title: article.title,
    link: article.link,
    source: article.source,
    scores: classified[idx]
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
  const items = clusters.map((c) => ({
    title: c.title, link: c.link, sources: c.sources, matchCount: c.sources.length,
    scores: {
      intention: avg(c.scoreList, 'intention'),
      intensity: avg(c.scoreList, 'intensity'),
      load: avg(c.scoreList, 'load'),
      confidence: avg(c.scoreList, 'confidence'),
      via: [...new Set(c.scoreList.map((s) => s.source))].join('+')   // which resource(s) scored this event
    }
  }));
  return { items, classStats };
}

// ---------------------------------------------------------------------------
// PULSE
// ---------------------------------------------------------------------------
function calculatePulse(items) {
  const charged = items.filter((i) => i.scores.intention !== 0); // neutral items shouldn't dilute the tone
  if (charged.length === 0) return { pulse: 0, peak: 0, peakLabel: 'QUIET' };

  const pulse = charged.reduce((a, i) => a + i.scores.load, 0) / charged.length;
  const peak = charged.reduce((m, i) => (Math.abs(i.scores.load) > Math.abs(m) ? i.scores.load : m), 0);
  const abs = Math.abs(peak);
  const peakLabel = abs > 0.7 ? 'ELEVATED' : abs > 0.4 ? 'ACTIVE' : 'QUIET';
  return { pulse: parseFloat(pulse.toFixed(2)), peak: parseFloat(peak.toFixed(2)), peakLabel };
}

// ---------------------------------------------------------------------------
// SELECTION — what matters, stated calmly.
// Confirmation by several outlets and scale raise the rank; emotional load LOWERS it,
// and at most one heavy story may appear among the main facts.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// RENDER — all feed content is untrusted: escape it, allow only http(s) links.
// ---------------------------------------------------------------------------
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

function renderPage({ mainFacts, balancing, pulse, builtAt }, { screen = false } = {}) {
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
${screen ? '<meta http-equiv="refresh" content="1800">' : ''}
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
  header {
    display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px;
    flex-wrap: wrap; gap: 12px;
  }
  h1 { font-size: 1.2rem; letter-spacing: -0.5px; }
  .pulse-badge {
    font-size: 0.85rem; background: rgba(56,189,248,0.1); color: var(--accent);
    padding: 4px 10px; border-radius: 4px; border: 1px solid rgba(56,189,248,0.2);
  }
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
  .tip-btn {
    background: transparent; color: var(--accent); border: 1px solid var(--accent);
    padding: 8px 16px; border-radius: 4px; font-family: inherit; font-size: 0.85rem;
    cursor: pointer; transition: all 0.2s ease;
  }
  .tip-btn:hover { background: var(--accent); color: var(--bg); }
  .footer-note { font-size: 0.75rem; color: var(--muted); }
  .screen .container { max-width: 960px; }
  .screen .feed-title { font-size: 1.3rem; }
  .screen .feed-meta { font-size: 0.9rem; }
</style>
</head>
<body class="${screen ? 'screen' : ''}">
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
      <button class="tip-btn" onclick="alert('Thank you. (0.10 € micro-payment simulation)')">Support calm — 0.10 €</button>
    </footer>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 12-HOUR RHYTHM — one snapshot per slot (08:00 and 18:00 in FEED_TZ).
// Requests never trigger fetching; they only read the current snapshot.
// ---------------------------------------------------------------------------
function currentSlot(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
    }).formatToParts(now).map((x) => [x.type, x.value])
  );
  // Shift wall-clock back 8h so that 08:00 → 00:00 and 18:00 → 10:00
  const shifted = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour) - 8 * 3600 * 1000);
  return `${shifted.toISOString().slice(0, 10)}-${shifted.getUTCHours() >= 10 ? 'pm' : 'am'}`;
}

let snapshot = null;
let refreshing = false;
let lastAttempt = 0;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  lastAttempt = Date.now();
  try {
    const slot = currentSlot();
    console.log(`[cycle] ${slot} — refreshing feeds...`);
    const t0 = Date.now();
    const { items, classStats } = await fetchAllArticles();
    if (items.length === 0) throw new Error('no articles fetched');

    const pulse = calculatePulse(items);
    const mainFacts = selectMainFacts(items, 3);
    const balancing = selectBalancing(items, mainFacts, 2);

    snapshot = { slot, mainFacts, balancing, pulse, builtAt: new Date() };
    console.log(`[cycle] ${items.length} events | Pulse ${pulse.pulse} | Peak ${pulse.peak} (${pulse.peakLabel})`);
    console.log(`[class] local=${classStats.local} cache=${classStats.cache} gemini=${classStats.gemini} fallback=${classStats.fallback} | api_calls=${classStats.apiCalls} retries=${classStats.retries}`);
    const cycleMs = Date.now() - t0;
    logCycle(items, pulse, mainFacts, balancing, classStats, cycleMs);
    logCycleJson(items, pulse, mainFacts, balancing, classStats, cycleMs);
  } catch (err) {
    console.error('[cycle] failed, keeping previous snapshot:', err.message);
  } finally {
    refreshing = false;
  }
}

function tick() {
  const stale = !snapshot || snapshot.slot !== currentSlot();
  if (stale && Date.now() - lastAttempt > RETRY_MS) refresh();
}

// ---------------------------------------------------------------------------
// SERVER
// ---------------------------------------------------------------------------
const app = express();

app.get('/', (req, res) => {
  if (!snapshot) {
    res.set('Retry-After', '30').status(503).send('Preparing the first bulletin — please try again in a moment.');
    return;
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.send(renderPage(snapshot, { screen: 'screen' in req.query }));   // /?screen → café-display mode
});

app.listen(PORT, () => {
  console.log(`Hype Feed 10c running: http://localhost:${PORT}  (rhythm: 08:00 / 18:00 ${TZ})`);
  refresh();
  setInterval(tick, 60 * 1000);
});
