import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'cache', 'classifier-cache.json');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const CHUNK_SIZE = Number(process.env.GEMINI_CHUNK_SIZE) || 15;
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS) || 4500;
const BACKOFF_MS = Number(process.env.GEMINI_BACKOFF_MS) || 2000;
const MAX_ATTEMPTS = 3;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const SNIPPET_CHARS = 160;

const set = (s) => new Set(s.split(/\s+/));
const STRONG_NEG = set(`killed kill kills killing dead death deaths dies died wounded injured massacre genocide
  airstrike airstrikes bombing shelling shooting murder fatalities casualties victims`);
const WEAK_NEG = set(`attack attacks attacked invasion war conflict crisis collapse disaster threat fear riot
  sanctions destroy destroyed damage devastation catastrophe emergency arrest arrested detained abuse
  harassment crime`);
const STRONG_POS = set(`peace breakthrough rescued recovery treaty milestone achievement celebrate landmark`);
const WEAK_POS = set(`agreement growth success aid cooperation restore restored improve progress safe heal
  reunite reform renewable conservation rescue`);
const AMPLIFIERS = set(`massive devastating unprecedented catastrophic severe major historic deadly fatal
  worst largest biggest nationwide`);
const DIMINISHERS = set(`minor small limited slight routine brief isolated alleged possible`);

const QUANTITY_CONTEXT = /\b(killed|kills?|killing|dead|deaths?|died|wounded|injured|displaced|affected|casualties|fatalities)\b/g;
const NUMBER_RE = /\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(thousand|million|billion|k|m|bn)?\b/g;
const NUMBER_WORD_RE = /\b(dozens|hundreds|thousands)\b/g;
const UNIT = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9 };
const NUMBER_WORDS = { dozens: 24, hundreds: 200, thousands: 2000 };

const tokens = (text) => text.toLowerCase().match(/[a-z]+/g) || [];
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n) => parseFloat(n.toFixed(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function quantities(text) {
  const out = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const unit = m[2];
    let value = parseFloat(m[1].replace(/,/g, ''));
    if (!unit && Number.isInteger(value) && value >= 1900 && value <= 2100) continue;
    if (unit) value *= UNIT[unit];
    if (value > 0) out.push({ value, index: m.index });
  }
  for (const m of text.matchAll(NUMBER_WORD_RE)) out.push({ value: NUMBER_WORDS[m[1]], index: m.index });
  return out;
}

function analyze(article) {
  const snippet = (article.contentSnippet || '').slice(0, SNIPPET_CHARS);
  const text = `${article.title || ''} ${snippet}`.toLowerCase();
  const words = new Set(tokens(text));
  const n = (list) => [...list].filter((w) => words.has(w)).length;
  return {
    text,
    strongNeg: n(STRONG_NEG), weakNeg: n(WEAK_NEG),
    strongPos: n(STRONG_POS), weakPos: n(WEAK_POS),
    amp: n(AMPLIFIERS), dim: n(DIMINISHERS)
  };
}

function extractIntensity(a) {
  let intensity = 0;
  const ctx = [...a.text.matchAll(QUANTITY_CONTEXT)].map((m) => m.index);
  const nearby = quantities(a.text)
    .filter((q) => ctx.some((c) => Math.abs(c - q.index) <= 40))
    .map((q) => q.value);
  if (nearby.length) intensity += Math.log10(Math.max(...nearby) + 1);
  return Math.max(0, intensity + 0.5 * a.amp - 0.3 * a.dim);
}

function build(intention, intensity, confidence, category, source) {
  const load = intention * Math.tanh(intensity / 3);
  return { intention: round(intention), intensity: round(intensity), confidence: round(confidence), category, load: round(load), source };
}

// Fallback when Gemini fails entirely
function scoreFallback(a) {
  const wNeg = 2 * a.strongNeg + a.weakNeg;
  const wPos = 2 * a.strongPos + a.weakPos;
  const intention = clamp((wPos - wNeg) / (wPos + wNeg + 1), -1, 1);
  const base = Math.min(2, 0.7 * (a.strongNeg + a.strongPos) + 0.3 * (a.weakNeg + a.weakPos));
  return build(intention, base + extractIntensity(a), 0.4, 'unknown', 'fallback');
}

// Cache
const cache = new Map();
let cacheLoaded = false;
let cacheDirty = false;
const cacheKey = (article) => crypto.createHash('sha1').update(`${article.title}|${(article.contentSnippet || '').slice(0, SNIPPET_CHARS)}`).digest('hex');

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) if (now - v.t < CACHE_TTL_MS) cache.set(k, v);
  } catch { /* no cache */ }
}

function saveCache() {
  if (!cacheDirty) return;
  try {
    const now = Date.now();
    const obj = {};
    for (const [k, v] of cache) {
      if (now - v.t < CACHE_TTL_MS) obj[k] = v; else cache.delete(k);
    }
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CACHE_FILE);
    cacheDirty = false;
  } catch (err) {
    console.error('[cache] save failed:', err.message);
  }
}

// Gemini
let client = null;
async function getClient() {
  if (!client) {
    const { GoogleGenAI } = await import('@google/genai');
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

const RETRYABLE = /429|500|503|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|timeout|fetch failed|SyntaxError|not an array/i;

async function askGemini(items, stats) {
  const prompt = `You rate news headlines for emotional weight. For EACH item return:
- id: the item's id, unchanged
- intention: -1 (war, death, disaster) .. +1 (peace, recovery, good news); 0 = neutral.
  Averted or absent harm ("no injuries", "ceasefire holds") is not negative.
- intensity: 0 (minor) .. 10 (catastrophic, mass casualties)
- confidence: 0 (guess) .. 1 (certain)
- category: one of [violence, politics, economy, disaster, culture, sports, health, science, other]

Return ONLY a JSON array, one object per item.

ITEMS_JSON:
${JSON.stringify(items)}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      stats.apiCalls++;
      const ai = await getClient();
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                intention: { type: 'number' },
                intensity: { type: 'number' },
                confidence: { type: 'number' },
                category: { type: 'string' }
              },
              required: ['id', 'intention', 'intensity', 'confidence', 'category']
            }
          }
        }
      });
      const parsed = JSON.parse(response.text);
      if (!Array.isArray(parsed)) throw new Error('response is not an array');
      return parsed;
    } catch (err) {
      stats.errors++;
      console.error(`[gemini] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      const retryable = RETRYABLE.test(`${err.status || ''} ${err.name || ''} ${err.message}`);
      if (!retryable || attempt === MAX_ATTEMPTS) return null;
      stats.retries++;
      await sleep(BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 500);
    }
  }
  return null;
}

// Main — everything goes to Gemini (unless cached)
export async function classifyBatch(articles) {
  loadCache();
  const t0 = Date.now();
  const stats = { total: articles.length, cache: 0, gemini: 0, fallback: 0, apiCalls: 0, retries: 0, errors: 0, ms: 0 };
  const results = new Array(articles.length);
  const pending = [];

  articles.forEach((article, idx) => {
    const key = cacheKey(article);
    const hit = cache.get(key);
    if (hit) {
      results[idx] = build(hit.intention, hit.intensity, hit.confidence, hit.category, 'cache');
      stats.cache++;
      return;
    }
    pending.push({ idx, article, key });
  });

  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CHUNK_SIZE);
    const items = chunk.map((p, id) => ({ id, title: p.article.title, snippet: (p.article.contentSnippet || '').slice(0, SNIPPET_CHARS) }));
    const answer = await askGemini(items, stats);
    const byId = new Map((answer || []).map((o) => [o.id, o]));

    chunk.forEach((p, id) => {
      const g = byId.get(id);
      if (g && Number.isFinite(g.intention) && Number.isFinite(g.intensity)) {
        const intention = clamp(g.intention, -1, 1);
        const intensity = clamp(g.intensity, 0, 10) * 0.4;
        const confidence = clamp(Number(g.confidence) || 0.5, 0, 1);
        const category = String(g.category || 'other');
        cache.set(p.key, { t: Date.now(), intention, intensity, confidence, category });
        cacheDirty = true;
        results[p.idx] = build(intention, intensity, confidence, category, 'gemini');
        stats.gemini++;
      } else {
        results[p.idx] = scoreFallback(analyze(p.article));
        stats.fallback++;
      }
    });

    if (i + CHUNK_SIZE < pending.length) await sleep(MIN_INTERVAL_MS);
  }

  saveCache();
  stats.ms = Date.now() - t0;
  return { results, stats };
}
