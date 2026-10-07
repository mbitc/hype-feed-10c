import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'logs');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function todayFile() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `${yyyy}-${mm}-${dd}.log`);
}

function append(line) {
  fs.appendFile(todayFile(), line + '\n', (err) => {
    if (err) console.error('[log] write failed:', err.message);
  });
}

// Per-source aggregation (shared by the text and JSON logs)
function aggregateBySource(items) {
  const bySource = new Map();
  for (const item of items) {
    const src = item.sources[0].name;
    if (!bySource.has(src)) bySource.set(src, { count: 0, load: 0, pos: 0, neg: 0, neu: 0 });
    const s = bySource.get(src);
    s.count++;
    s.load += item.scores.load;
    if (item.scores.load > 0.1) s.pos++;
    else if (item.scores.load < -0.1) s.neg++;
    else s.neu++;
  }
  return bySource;
}

const fmtTag = (item) => `via=${item.scores.via} conf=${item.scores.confidence}`;
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

// Called after each successful cycle.
// classStats comes from classifyBatch(): how many headlines each resource handled.
export function logCycle(items, pulse, mainFacts, balancing, classStats = null, cycleMs = 0) {
  append(`\n=== Cycle ${new Date().toISOString()} ===`);

  if (classStats) {
    const c = classStats;
    append(
      `[class] headlines=${c.total} local=${c.local} cache=${c.cache} gemini=${c.gemini} fallback=${c.fallback}` +
      ` | needed-llm=${c.uncertain} (${c.total ? Math.round((100 * c.uncertain) / c.total) : 0}%)` +
      ` | api_calls=${c.apiCalls} retries=${c.retries} errors=${c.errors}` +
      ` | classify=${secs(c.ms)} cycle=${secs(cycleMs)}`
    );
  }

  for (const [name, s] of aggregateBySource(items)) {
    const avg = (s.load / s.count).toFixed(2);
    append(`[src] ${name.padEnd(18)} ${s.count} items | avg ${avg} | +${s.pos} -${s.neg} =${s.neu}`);
  }

  append(`[cycle] total=${items.length} pulse=${pulse.pulse} peak=${pulse.peak} (${pulse.peakLabel})`);

  mainFacts.forEach((item, i) => append(`[fact${i + 1}] load=${item.scores.load} ${fmtTag(item)} | ${item.title}`));
  balancing.forEach((item, i) => append(`[bal${i + 1}] load=${item.scores.load} ${fmtTag(item)} | ${item.title}`));

  // Audit trail for tuning the local filter: events that were NOT settled by the local lexicon alone
  const assisted = items.filter((i) => i.scores.via !== 'local').slice(0, 15);
  assisted.forEach((item) => append(`[assist] ${item.scores.via} load=${item.scores.load} | ${item.title}`));
}

// Machine-readable line, one per cycle.
export function logCycleJson(items, pulse, mainFacts, balancing, classStats = null, cycleMs = 0) {
  const record = {
    ts: new Date().toISOString(),
    pulse: pulse.pulse,
    peak: pulse.peak,
    peakLabel: pulse.peakLabel,
    total: items.length,
    classification: classStats ? { ...classStats, cycleMs } : null,
    mainFacts: mainFacts.map((i) => ({
      load: i.scores.load, via: i.scores.via, confidence: i.scores.confidence,
      title: i.title, sources: i.sources.map((s) => s.name)
    })),
    balancing: balancing.map((i) => ({ load: i.scores.load, via: i.scores.via, confidence: i.scores.confidence, title: i.title })),
    sources: {}
  };

  for (const [name, s] of aggregateBySource(items)) {
    record.sources[name] = {
      count: s.count,
      avgLoad: parseFloat((s.load / s.count).toFixed(2)),
      pos: s.pos, neg: s.neg, neu: s.neu
    };
  }

  fs.appendFile(path.join(LOG_DIR, 'cycles.jsonl'), JSON.stringify(record) + '\n', (err) => {
    if (err) console.error('[log] json write failed:', err.message);
  });
}
