// Label counts of the collected nation decision data.
//   node tools/nn-nation/nationDataStats.mjs [dir]   (default .nn-nation-data)
import fs from "fs";
import path from "path";

const dir = process.argv[2] ?? ".nn-nation-data";
const raw = path.join(dir, "raw");
const files = fs.readdirSync(raw).filter((f) => f.endsWith(".jsonl"));

const inc = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const show = (title, m) => {
  console.log(`\n${title}`);
  for (const [k, v] of [...m].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(k).padEnd(28)} ${v}`);
  }
};

const engage = new Map(); // reached / decision / pass split
const preempt = new Map(); // turns where the rules acted before engage
const rule = new Map(); // which rule's target was attacked
const targetType = new Map(); // chosen target type
const candSizes = [];
let bytes = 0;
let eRows = 0;
let tRows = 0;
let outside = 0;
let unobserved = 0;
const perGame = new Map();

for (const f of files) {
  bytes += fs.statSync(path.join(raw, f)).size;
  const lines = fs.readFileSync(path.join(raw, f), "utf8").split("\n");
  const game = f.replace(".jsonl", "");
  for (const line of lines) {
    if (!line) continue;
    const r = JSON.parse(line);
    inc(perGame, game);
    if (r.t === "e") {
      eRows++;
      if (!r.reached) {
        inc(engage, "engage not reached");
        inc(preempt, r.pre.length > 0 ? "rules attacked first" : "nothing sent");
      } else if (r.decision === "attack") {
        inc(engage, r.c10Called && r.c10Pass ? "attack (1/10 pass)" : "attack");
      } else if (r.decision === "hold") {
        inc(engage, r.c10Called ? "hold (draw failed)" : "hold (reserve)");
      } else {
        inc(engage, `other:${r.decision}`);
      }
    } else if (r.t === "t") {
      tRows++;
      candSizes.push(r.c.length);
      if (r.none) inc(rule, "none (fell to donate)");
      else inc(rule, r.rule);
      if (r.y >= 0) inc(targetType, "chosen among candidates");
      else if (r.out) {
        inc(targetType, "chosen outside candidates");
        outside++;
      } else if (!r.none) {
        inc(targetType, "rule fired, nothing observed");
        unobserved++;
      }
    }
  }
}

const games = fs.existsSync(path.join(dir, "games.jsonl"))
  ? fs
      .readFileSync(path.join(dir, "games.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
  : [];
console.log(`games: ${files.length}  (games.jsonl: ${games.length})`);
console.log(`size: ${(bytes / 1e6).toFixed(1)} MB  rows: engage ${eRows}, target ${tRows}`);
const by = (key) => {
  const m = new Map();
  for (const g of games) inc(m, g[key]);
  return m;
};
show("games by map", by("map"));
show("games by opening", by("opening"));
show("games by nation count", by("nations"));
show("engage rows", engage);
show("engage not reached: what happened", preempt);
show("target rows: rule that attacked", rule);
show("target rows: chosen target", targetType);
candSizes.sort((a, b) => a - b);
const q = (p) => candSizes[Math.floor((candSizes.length - 1) * p)];
console.log(
  `\ncandidates per target row: min ${q(0)} median ${q(0.5)} p90 ${q(0.9)} max ${q(1)}`,
);
console.log(`chosen outside candidates: ${outside}, unobserved: ${unobserved}`);
