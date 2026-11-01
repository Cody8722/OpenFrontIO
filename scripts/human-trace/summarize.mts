// Summarise a Human Trace recording (see src/client/humanTrace).
//
//   npx tsx scripts/human-trace/summarize.mts <id>.jsonl [<id>.record.json] [--out <dir>]
//
// Writes <id>.summary.md and <id>.summary.json (next to the input unless --out).
// Tolerant on purpose: bad lines are counted and skipped, missing optional
// fields read as absent, a game cut short just yields shorter statistics.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const [tracePath, recordPath] = args;
if (!tracePath) {
  console.error("usage: summarize.mts <trace.jsonl> [record.json] [--out dir]");
  process.exit(2);
}

// ---------- reading ----------

type Row = Record<string, any>;

function readLines(file: string) {
  const rows: Row[] = [];
  let bad = 0;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { rows, bad: 0, error: String((e as Error).message) };
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line);
      if (o !== null && typeof o === "object" && !Array.isArray(o))
        rows.push(o);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}

function readRecord(file: string | undefined): {
  turns: Row[];
  header: Row | null;
  repaired?: boolean;
  missing?: boolean;
} {
  if (!file) return { turns: [], header: null };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { turns: [], header: null, missing: true };
  }
  try {
    const d = JSON.parse(text);
    return {
      turns: Array.isArray(d.turns) ? d.turns : [],
      header: d.header ?? null,
    };
  } catch {
    // A record cut off mid-write: salvage whole turn objects.
    const turns: Row[] = [];
    for (const m of text.matchAll(
      /\{"turnNumber":\d+,"intents":.*?"arrivalMs":[\d.]+\}/g,
    )) {
      try {
        turns.push(JSON.parse(m[0]));
      } catch {
        // skip
      }
    }
    return { turns, header: null, repaired: true };
  }
}

// ---------- small stats ----------

const num = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
function pct(sorted: number[], p: number) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function describe(values: unknown[]): Row {
  const v = values.filter(num).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    min: v[0],
    p10: pct(v, 10),
    p50: pct(v, 50),
    p90: pct(v, 90),
    p99: pct(v, 99),
    max: v[v.length - 1],
    mean: Math.round(mean * 100) / 100,
  };
}
function histogram(values: number[], edges: number[]): Row {
  const out = Object.fromEntries(edges.map((e) => [`<${e}`, 0]));
  out[`>=${edges[edges.length - 1]}`] = 0;
  for (const x of values) {
    const e = edges.find((b) => x < b);
    out[e === undefined ? `>=${edges[edges.length - 1]}` : `<${e}`]++;
  }
  return out;
}

// ---------- analysis ----------

const { rows, bad, error } = readLines(tracePath);
const record = readRecord(recordPath);
const header = rows.find((r) => r.k === "header") ?? null;
const inputs = rows.filter((r) => r.k === "input" && num(r.tMs));
const intents = rows.filter((r) => r.k === "intent" && num(r.tMs));
const sent = intents.filter((r) => r.outcome === "sent");

const summary: Row = {
  file: path.basename(tracePath),
  parse: { lines: rows.length, badLines: bad, error: error ?? null },
  header: header
    ? {
        gameID: header.gameID,
        commit: header.commit,
        mode: header.mode,
        map: header.map,
        difficulty: header.difficulty,
        urlParams: header.urlParams,
        screen: header.screen,
      }
    : null,
  complete: rows.some((r) => r.k === "end"),
  counts: {
    inputs: inputs.length,
    intents: intents.length,
    byType: {},
    byOutcome: {},
  },
};
for (const r of intents) {
  summary.counts.byType[r.type] = (summary.counts.byType[r.type] ?? 0) + 1;
  summary.counts.byOutcome[r.outcome] =
    (summary.counts.byOutcome[r.outcome] ?? 0) + 1;
}

// operations per second (sent intents)
{
  const bySec = new Map();
  for (const r of sent) {
    const s = Math.floor(r.tMs / 1000);
    bySec.set(s, (bySec.get(s) ?? 0) + 1);
  }
  const lastSec = intents.length
    ? Math.floor(Math.max(...intents.map((r) => r.tMs)) / 1000)
    : 0;
  const all = [];
  for (let s = 0; s <= lastSec; s++) all.push(bySec.get(s) ?? 0);
  const active = [...bySec.values()];
  summary.opsPerSecond = {
    wholeGame: describe(all),
    activeSecondsOnly: describe(active),
    distribution: histogram(active, [2, 3, 5, 8, 11, 16]),
  };
}

// bursts: 5+ intents of one type, each within 1 s of the previous one
{
  const bursts: Row[] = [];
  let cur: Row[] = [];
  const flush = () => {
    if (cur.length >= 5) {
      const dur = cur[cur.length - 1].tMs - cur[0].tMs;
      bursts.push({
        type: cur[0].type,
        startMs: cur[0].tMs,
        endMs: cur[cur.length - 1].tMs,
        count: cur.length,
        opsPerSecond:
          dur > 0 ? Math.round(((cur.length - 1) / dur) * 10000) / 10 : null,
      });
    }
    cur = [];
  };
  for (const r of sent) {
    const last = cur[cur.length - 1];
    if (last && (last.type !== r.type || r.tMs - last.tMs > 1000)) flush();
    cur.push(r);
  }
  flush();
  summary.bursts = bursts;
}

// gaps between neighbouring intents
{
  const gaps = [];
  for (let i = 1; i < sent.length; i++)
    gaps.push(sent[i].tMs - sent[i - 1].tMs);
  summary.intentGapsMs = {
    stats: describe(gaps),
    histogram: histogram(gaps, [50, 100, 200, 500, 1000, 5000]),
  };
}

// where things were built: the world cell of the click that produced the intent
{
  const clicks = inputs.filter(
    (r) => (r.type === "pointerup" || r.type === "pointerdown") && r.world,
  );
  const points = [];
  const builds = sent.filter((r) => r.type === "build_unit");
  for (const b of builds) {
    let hit = null;
    for (let i = clicks.length - 1; i >= 0; i--) {
      const c = clicks[i];
      if (c.tMs > b.tMs) continue;
      if (b.tMs - c.tMs > 400) break;
      hit = c;
      break;
    }
    if (hit) points.push({ x: hit.world.x, y: hit.world.y });
  }
  const spatial: Row = { builds: builds.length, located: points.length };
  if (points.length > 0) {
    const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
    const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    spatial.centroid = {
      x: Math.round(cx * 10) / 10,
      y: Math.round(cy * 10) / 10,
    };
    spatial.bbox = {
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys),
    };
    const g = 8;
    const w = Math.max(1, spatial.bbox.x1 - spatial.bbox.x0 + 1);
    const h = Math.max(1, spatial.bbox.y1 - spatial.bbox.y0 + 1);
    const grid = Array.from({ length: g }, () => Array(g).fill(0));
    for (const p of points) {
      const gx = Math.min(g - 1, Math.floor(((p.x - spatial.bbox.x0) / w) * g));
      const gy = Math.min(g - 1, Math.floor(((p.y - spatial.bbox.y0) / h) * g));
      grid[gy][gx]++;
    }
    spatial.grid8x8 = grid;
    // Ring-ness around the centroid of the build points. The target's own
    // territory centre is not in the trace, so this is a shape measure of the
    // points themselves, not of a particular island.
    const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const mr = radii.reduce((a, b) => a + b, 0) / radii.length;
    const sr = Math.sqrt(
      radii.reduce((a, b) => a + (b - mr) ** 2, 0) / radii.length,
    );
    const sectors = new Set(
      points.map(
        (p) =>
          Math.floor(
            ((Math.atan2(p.y - cy, p.x - cx) + Math.PI) / (2 * Math.PI)) * 12,
          ) % 12,
      ),
    );
    const cv = mr > 0 ? sr / mr : null;
    spatial.ring = {
      meanRadius: Math.round(mr * 10) / 10,
      radiusStd: Math.round(sr * 10) / 10,
      radiusCV: cv === null ? null : Math.round(cv * 1000) / 1000,
      angularCoverage12: sectors.size / 12,
      ringScore:
        cv === null
          ? null
          : Math.round(
              (sectors.size / 12) * Math.max(0, 1 - Math.min(cv, 1)) * 1000,
            ) / 1000,
      note: "relative to the centroid of the build points; a perfect ring has CV near 0 and coverage 1",
    };
  }
  summary.buildSpatial = spatial;
}

// clicks that should have built something but produced no intent
{
  const clicks = inputs.filter(
    (r) =>
      (r.type === "pointerup" || r.type === "drag") &&
      r.selected &&
      r.button === 0,
  );
  let blocked = 0;
  for (const c of clicks) {
    const produced = intents.some(
      (i) =>
        (i.type === "build_unit" || i.type === "upgrade_structure") &&
        i.tMs >= c.tMs - 5 &&
        i.tMs - c.tMs <= 400,
    );
    if (!produced) blocked++;
  }
  summary.blocked = {
    clicksWithBuildSelected: clicks.length,
    inferredBlocked: blocked,
    ratio: clicks.length
      ? Math.round((blocked / clicks.length) * 1000) / 1000
      : null,
    reason:
      "unknown (no intent followed a click with a unit selected; the precheck is not instrumented)",
    droppedPaused: summary.counts.byOutcome.dropped_paused ?? 0,
  };
}

// who: this version records single-player only
summary.players = {
  note: "single-player recording; one human player",
  list: header?.players ?? [],
};

// confirmation by the turn stream, and wall time per turn
{
  const turns = record.turns
    .filter((t) => num(t.turnNumber))
    .sort((a, b) => a.turnNumber - b.turnNumber);
  const strip = (p: Row | undefined) => {
    // The server stamps clientID onto a turn's intent; the trace's copy has none.
    const rest = { ...(p ?? {}) };
    delete rest.clientID;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  const used = new Set();
  const latencies = [];
  let confirmed = 0;
  let unconfirmed = 0;
  for (const it of sent) {
    const want = strip(it.params);
    let found = null;
    for (const t of turns) {
      if (t.turnNumber < (it.serverTick ?? 0)) continue;
      const idx = (t.intents ?? []).findIndex(
        (x: Row, j: number) =>
          !used.has(`${t.turnNumber}:${j}`) &&
          x.type === it.type &&
          strip(x) === want,
      );
      if (idx >= 0) {
        used.add(`${t.turnNumber}:${idx}`);
        found = t;
        break;
      }
      if (t.turnNumber > (it.serverTick ?? 0) + 5) break;
    }
    if (found) {
      confirmed++;
      if (num(found.arrivalMs)) latencies.push(found.arrivalMs - it.tMs);
    } else unconfirmed++;
  }
  summary.confirmation = {
    recordTurns: turns.length,
    sent: sent.length,
    confirmedInTurnStream: confirmed,
    notFound: turns.length === 0 ? "no record supplied" : unconfirmed,
    droppedPaused: summary.counts.byOutcome.dropped_paused ?? 0,
    latencyMs: describe(latencies),
    note: "single-player has no server reply; 'confirmed' means the intent appears in a turn within 5 turns",
  };
  const dts = [];
  for (let i = 1; i < turns.length; i++) {
    if (num(turns[i].arrivalMs) && num(turns[i - 1].arrivalMs)) {
      dts.push(turns[i].arrivalMs - turns[i - 1].arrivalMs);
    }
  }
  const span =
    turns.length > 1
      ? (turns[turns.length - 1].arrivalMs - turns[0].arrivalMs) / 1000
      : 0;
  summary.turnTiming = {
    turns: turns.length,
    intervalMs: describe(dts),
    turnsPerSecond:
      span > 0 ? Math.round(((turns.length - 1) / span) * 100) / 100 : null,
  };
  const sync = rows.filter((r) => r.k === "sync" && num(r.tick));
  summary.tickVsTurn = {
    samples: sync.length,
    offsets: describe(sync.map((s) => s.turnNumber - s.tick)),
    note: "turnNumber - gameTick when the turn arrived; the game lags the turn stream by this many ticks",
  };
}

// ---------- output ----------

const base = path.basename(tracePath).replace(/\.jsonl$/, "");
const dir = outDir ?? path.dirname(tracePath);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, `${base}.summary.json`),
  JSON.stringify(summary, null, 2),
);

const block = (o: unknown) => [
  "```json",
  JSON.stringify(o, null, 2),
  "```",
  "",
];
const md = [
  `# Human Trace summary: ${base}`,
  "",
  `- lines parsed ${summary.parse.lines}, bad ${summary.parse.badLines}${summary.parse.error ? `, error: ${summary.parse.error}` : ""}`,
  `- complete (end line present): ${summary.complete}`,
  `- inputs ${summary.counts.inputs}, intents ${summary.counts.intents}`,
  "",
  "## Intents",
  "",
  "| type | count |",
  "|---|---|",
  ...Object.entries(summary.counts.byType).map(([k, v]) => `| ${k} | ${v} |`),
  "",
  `outcomes: ${JSON.stringify(summary.counts.byOutcome)}`,
  "",
  "## Operations per second (sent intents)",
  "",
  ...block(summary.opsPerSecond),
  `## Bursts (5+ of one type, each within 1 s): ${summary.bursts.length}`,
  "",
  ...(summary.bursts.length
    ? [
        "| type | start ms | end ms | count | ops/s |",
        "|---|---|---|---|---|",
        ...summary.bursts.map(
          (b: Row) =>
            `| ${b.type} | ${b.startMs} | ${b.endMs} | ${b.count} | ${b.opsPerSecond} |`,
        ),
        "",
      ]
    : ["none", ""]),
  "## Gaps between intents (ms)",
  "",
  ...block(summary.intentGapsMs),
  "## Build positions",
  "",
  ...block(summary.buildSpatial),
  "## Blocked clicks (inferred)",
  "",
  ...block(summary.blocked),
  "## Confirmation by the turn stream",
  "",
  ...block(summary.confirmation),
  "## Turn timing and tick offset",
  "",
  ...block({ turnTiming: summary.turnTiming, tickVsTurn: summary.tickVsTurn }),
];
fs.writeFileSync(path.join(dir, `${base}.summary.md`), md.join("\n"));
console.log(`wrote ${path.join(dir, `${base}.summary.md`)}`);
