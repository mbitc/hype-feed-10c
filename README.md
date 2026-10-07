# Hype Feed 10c

> A calm-news mirror. Not a source of truth — a measure of the emotional
> temperature carried by global information streams.

---

## Manifesto & Philosophy

Modern information streams carry a structurally negative tone — not
because the world is getting worse, but because conflict, crisis and
threat are what the attention economy rewards. A person who reads the
news regularly receives a persistent low-grade negative signal, often
without noticing it.

Hype Feed 10c is built as an **information monastery** — a quiet, offline-first 
digital space to detach from chaotic, emotionally-numbing global streams 
and gain objective, systematic insights. 

It is not a cure. It is a **thermometer**. It makes the signal
visible, transforming raw media pressure into a structured, therapeutic mirror 
so a reader can observe the world without burning out in it.

---

## What it is

Hype Feed 10c reads RSS headlines from ten independent international
news outlets, rates each one for **emotional intention** and **intensity**
using an LLM, and publishes a single static page with:

- **Pulse** — the average emotional load of the day
- **Peak** — the single heaviest event
- **Main facts** — cross-confirmed stories, low emotional load first
- **Balancing signals** — positive stories, when they exist

It does not aggregate the news. It measures what the news *feels like*
when you read it.

## What it isn't

- It is **not** a news source. It links to the original articles.
- It is **not** an objective measure of world events. It is a mirror of
  what the information streams choose to say.
- It is **not** a real-time dashboard. It is a twice-daily snapshot.

---

## How it works


```

RSS feeds (10 sources)
↓
Parser (rss-parser)
↓
Classifier (Gemini Flash + local fallback lexicon)
↓
Cluster (same-event detection across sources)
↓
Pulse, Peak, Main facts, Balancing
↓
Static HTML + JSONL log

```

### Emotional load model

Each article is rated on two axes:

- **Intention** — `-1` (war, death) to `+1` (peace, recovery), `0` = neutral
- **Intensity** — `0` (minor) to `10` (catastrophic)

The final **load** is:


```

load = intention × tanh(intensity / 3)

```

Load is normalised to roughly `[-1, +1]`. The `tanh` compression prevents a
single catastrophic event from drowning out the rest of the day.

### Sources

| Source         | Region    |
|----------------|-----------|
| BBC World      | UK        |
| Deutsche Welle | Germany   |
| France 24      | France    |
| The Guardian   | UK        |
| Al Jazeera     | Qatar     |
| Japan Today    | Japan     |
| Global News    | Canada    |


---

## Output

Two files are written to `docs/`:

- **`docs/index.html`** — the static page, regenerated every cycle
- **`docs/cycles.jsonl`** — one JSON record per cycle, appended over time

The JSONL file is the long-term asset. It lives in git history for reproducibility and long-term analysis.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# edit .env and set GEMINI_API_KEY

# 3. Run one cycle
node generate.js

```

### Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Required |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Any Gemini model with JSON output |
| `GEMINI_CHUNK_SIZE` | `15` | Headlines per API call |
| `GEMINI_MIN_INTERVAL_MS` | `4500` | Pause between calls (~13 RPM) |
| `GEMINI_BACKOFF_MS` | `2000` | Base retry backoff |
| `FEED_TZ` | `Europe/Vilnius` | Display timezone |

Free tier of Gemini is sufficient for two cycles per day.

---

## Current status

* **Active & Stable:** RSS ingestion from 10 global nodes, hybrid Gemini classification (with ~3% API usage via caching), fallback lexicons, and static HTML generation running locally on Arch Linux (ThinkPad T430).
* **Known limitations:** Manual triggering twice a day (automation via GitHub Actions planned); calibration weights ongoing.

---

## Not affiliated with anything

No ads, no tracking, no subscription walls, no sponsors.

## License

MIT
