// Label counts per opening and per map, the train/val/test split by gameID,
// and the number of usable rows.
//   node tests/util/nationDataSplit.mjs [dir]   (default .nn-nation-data)
// Writes <dir>/split.json ({ gameID: "train" | "val" | "test" }).
//
// Engage labels (rows that reached the engage decision):
//   below_reserve  troops under the reserve ratio: hold
//   between        reserve reached, trigger not: the rules' 1-in-10 draw decides;
//                  stays in the rule shell, not given to the network
//   both_passed    both ratios reached: attack
// Target labels (rows that reached the strength block):
//   <rule>                 the rule that attacked (with at least one candidate)
//   none_with_candidates   candidates existed but every rule refused (donate next)
//   none_zero_candidates   no candidate at all: not trained on
import fs from "fs";
import path from "path";

const dir = process.argv[2] ?? ".nn-nation-data";
const raw = path.join(dir, "raw");
const games = fs
  .readFileSync(path.join(dir, "games.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const inc = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const hash = (s) => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
};

// ---- split: stratified by map x opening, at least one game each to val and test
const split = {};
const byStratum = new Map();
for (const g of games) {
  const k = `${g.map}|${g.opening}`;
  if (!byStratum.has(k)) byStratum.set(k, []);
  byStratum.get(k).push(g.gameID);
}
for (const ids of byStratum.values()) {
  ids.sort((a, b) => hash(a) - hash(b) || (a < b ? -1 : 1));
  const nVal = Math.max(1, Math.round(ids.length * 0.1));
  const nTest = Math.max(1, Math.round(ids.length * 0.1));
  ids.forEach((id, i) => {
    split[id] = i < nTest ? "test" : i < nTest + nVal ? "val" : "train";
  });
}
fs.writeFileSync(path.join(dir, "split.json"), JSON.stringify(split, null, 1));

// ---- counts -----------------------------------------------------------------
const meta = new Map(games.map((g) => [g.gameID, g]));
const tally = {
  all: new Map(),
  opening: new Map(),
  map: new Map(),
  set: new Map(),
};
const bump = (g, kind, label) => {
  const m = meta.get(g);
  const keys = { all: "all", opening: m.opening, map: m.map, set: split[g] };
  for (const [scope, key] of Object.entries(keys)) {
    const t = tally[scope];
    if (!t.has(key)) t.set(key, new Map());
    inc(t.get(key), `${kind}:${label}`);
  }
};

for (const g of games) {
  const lines = fs
    .readFileSync(path.join(raw, `${g.gameID}.jsonl`), "utf8")
    .split("\n");
  for (const line of lines) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.t === "e") {
      if (!r.reached) bump(g.gameID, "engage", "not_reached");
      else if (!r.hasReserve) bump(g.gameID, "engage", "below_reserve");
      else if (r.hasTrigger) bump(g.gameID, "engage", "both_passed");
      else
        bump(g.gameID, "engage", r.c10Pass ? "between(pass)" : "between(fail)");
    } else if (r.t === "t") {
      if (r.rule !== null) {
        bump(
          g.gameID,
          "target",
          r.c.length === 0 ? "rule_zero_candidates!" : r.rule,
        );
      } else {
        bump(
          g.gameID,
          "target",
          r.c.length === 0 ? "none_zero_candidates" : "none_with_candidates",
        );
      }
    }
  }
}

const allLabels = [...tally.all.get("all").keys()].sort();
const table = (scope) => {
  const keys = [...tally[scope].keys()].sort();
  const w = 26;
  console.log(`\n== by ${scope} ==`);
  console.log(
    "label".padEnd(w) + keys.map((k) => k.slice(-12).padStart(13)).join(""),
  );
  for (const l of allLabels) {
    console.log(
      l.padEnd(w) +
        keys
          .map((k) => String(tally[scope].get(k).get(l) ?? 0).padStart(13))
          .join(""),
    );
  }
};
console.log(`games ${games.length}`);
table("all");
table("opening");
table("map");
table("set");

// ---- usable rows --------------------------------------------------------------
console.log("\n== usable rows ==");
for (const key of ["all", "train", "val", "test"]) {
  const t = tally[key === "all" ? "all" : "set"].get(key);
  const engage =
    (t.get("engage:below_reserve") ?? 0) + (t.get("engage:both_passed") ?? 0);
  let target = 0;
  for (const [l, v] of t) {
    if (l.startsWith("target:") && l !== "target:none_zero_candidates") {
      target += v;
    }
  }
  console.log(`${key.padEnd(6)} engage ${engage}  target ${target}`);
}
const nGames = { train: 0, val: 0, test: 0 };
for (const v of Object.values(split)) nGames[v]++;
console.log(`games per set: ${JSON.stringify(nGames)}`);
let missing = 0;
for (const [k, ids] of byStratum) {
  if (new Set(ids.map((i) => split[i])).size < 3) missing++;
  if (ids.length < 3) console.log(`stratum ${k} has only ${ids.length} games`);
}
console.log(`strata ${byStratum.size}, strata missing from a set: ${missing}`);
