// Collects nation attack-decision data (JSONL) from headless Hard FFA games.
// Behaviour pinned: recording does not change the game (same tick-level hash
// chain as the unrecorded baseline). Runs only with NN_COLLECT=1; output goes
// to .nn-nation-data/raw/<gameID>.jsonl (one file per game, resumable).
//   NN_COLLECT_PLAN=pilot|full   NN_COLLECT_TICKS=<n> (default 6000)
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DecisionRecorder, RecorderMode, SCHEMA } from "./util/NationRecorder";
import { TraceSpec, loadWorldNations, traceWorld } from "./util/NationTrace";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(
  __dirname,
  "..",
  process.env.NN_COLLECT_DIR ?? ".nn-nation-data",
);
const RAW = path.join(ROOT, "raw");
const GAMES = path.join(ROOT, "games.jsonl");
const BASELINE = path.join(__dirname, "testdata/nn-nation/baseline-trace.json");

const enabled = process.env.NN_COLLECT === "1";
const ticks = Number(process.env.NN_COLLECT_TICKS ?? 6000);

const MAPS: { map: string; nations: number }[] = [
  { map: "world", nations: 61 },
  { map: "real:asia", nations: 25 },
  { map: "real:britannia", nations: 20 },
  { map: "real:caribbean", nations: 34 },
  { map: "real:baltics", nations: 35 },
  { map: "real:eastasia", nations: 22 },
  { map: "real:africa", nations: 44 },
  { map: "real:europe", nations: 52 },
  { map: "real:balkans", nations: 23 },
];

type Opening = "normal" | "rich";

function plan(kind: string): TraceSpec[] {
  const out: TraceSpec[] = [];
  const maps = kind === "pilot" ? MAPS.slice(0, 2) : MAPS;
  const seeds =
    kind === "pilot" ? 1 : Number(process.env.NN_COLLECT_SEEDS ?? 3);
  for (const { map, nations } of maps) {
    for (const n of [nations, Math.round(nations / 2)]) {
      for (const opening of ["normal", "rich"] as Opening[]) {
        for (let s = 0; s < seeds; s++) {
          const id = `${map.replace("real:", "")}-${opening}-n${n}-s${s}`;
          out.push({
            label: id,
            gameID: id,
            map,
            difficulty: Difficulty.Hard,
            nations: n,
            ticks,
            ...(opening === "rich"
              ? { startingGold: 1_000_000_000, goldMultiplier: 10 }
              : {}),
          });
        }
      }
    }
  }
  return out;
}

async function recordGame(
  spec: TraceSpec,
  file: string,
  mode: RecorderMode = "full",
) {
  let idx = 0;
  const recorders: DecisionRecorder[] = [];
  const t0 = Date.now();
  const { result, game } = await traceWorld(
    spec,
    undefined,
    undefined,
    (nation, g) => {
      const r = new DecisionRecorder(
        g,
        nation.playerInfo.id,
        idx++,
        spec.gameID,
        file,
        mode,
      );
      recorders.push(r);
      return r;
    },
  );
  recorders.forEach((r) => r.flush());
  return { result, game, ms: Date.now() - t0 };
}

describe.skipIf(!enabled)("nation decision collection", () => {
  test(
    "recording does not change the game",
    async () => {
      const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
      const spec: TraceSpec = {
        label: "hard-a",
        gameID: "nn-seed-a",
        difficulty: Difficulty.Hard,
        nations: 40,
        ticks: 6000,
      };
      fs.mkdirSync(RAW, { recursive: true });
      const tmp = path.join(ROOT, "neutrality-check.jsonl");
      fs.rmSync(tmp, { force: true });
      const mode = (process.env.NN_REC_MODE ?? "full") as RecorderMode;
      const { result } = await recordGame(spec, tmp, mode);
      const bad = result.checkpoints.findIndex(
        (c, i) => c !== baseline["hard-a"].checkpoints[i],
      );
      process.stderr.write(
        `[neutral] mode ${mode} first bad checkpoint ${bad}\n`,
      );
      expect(result.chain).toBe(baseline["hard-a"].chain);
      expect(result.attacksStarted).toBe(baseline["hard-a"].attacksStarted);
      const rows = fs.readFileSync(tmp, "utf8").trim().split("\n");
      expect(rows.length).toBeGreaterThan(100);
    },
    30 * 60 * 1000,
  );

  test.each([
    ["world", 40],
    ["real:asia", 25],
    ["real:britannia", 20],
  ])(
    "recorder on/off hash chains match on %s (normal and rich)",
    async (map, nations) => {
      fs.mkdirSync(RAW, { recursive: true });
      for (const rich of [false, true]) {
        const spec: TraceSpec = {
          label: "neutral",
          gameID: `neutral-${map}-${rich}`,
          map,
          difficulty: Difficulty.Hard,
          nations,
          ticks: 6000,
          ...(rich ? { startingGold: 1_000_000_000, goldMultiplier: 10 } : {}),
        };
        const off = (await traceWorld(spec)).result;
        const tmp = path.join(ROOT, "neutrality-check.jsonl");
        fs.rmSync(tmp, { force: true });
        const on = (await recordGame(spec, tmp)).result;
        const bad = on.checkpoints.findIndex(
          (c, i) => c !== off.checkpoints[i],
        );
        process.stderr.write(
          `[neutral] ${map} ${rich ? "rich" : "normal"} first bad checkpoint ${bad}\n`,
        );
        expect(bad).toBe(-1);
        expect(on.chain).toBe(off.chain);
        expect(on.attacksStarted).toBe(off.attacksStarted);
      }
    },
    60 * 60 * 1000,
  );

  test(
    "collect",
    async () => {
      fs.mkdirSync(RAW, { recursive: true });
      fs.writeFileSync(
        path.join(ROOT, "schema.json"),
        JSON.stringify(SCHEMA, null, 1),
      );
      const done = new Set<string>(
        fs.existsSync(GAMES)
          ? fs
              .readFileSync(GAMES, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l).gameID)
          : [],
      );
      const only = process.env.NN_COLLECT_ONLY?.split(",");
      const specs = plan(process.env.NN_COLLECT_PLAN ?? "pilot").filter(
        (s) => only === undefined || only.includes(s.gameID),
      );
      let n = 0;
      for (const spec of specs) {
        if (done.has(spec.gameID)) continue;
        const file = path.join(RAW, `${spec.gameID}.jsonl`);
        fs.rmSync(file, { force: true });
        const { result, game, ms } = await recordGame(spec, file);
        const alive = game.players().filter((p) => p.isAlive()).length;
        fs.appendFileSync(
          GAMES,
          JSON.stringify({
            gameID: spec.gameID,
            map: spec.map,
            nations: loadWorldNations(spec.nations, spec.map).length,
            opening: spec.startingGold ? "rich" : "normal",
            ticks: spec.ticks,
            attacksStarted: result.attacksStarted,
            aliveEnd: alive,
            bytes: fs.statSync(file).size,
            ms,
          }) + "\n",
        );
        n++;
        process.stderr.write(
          `[collect] ${n}/${specs.length - done.size} ${spec.gameID} ${ms} ms ` +
            `${Math.round(fs.statSync(file).size / 1024)} KB alive ${alive}\n`,
        );
      }
    },
    6 * 60 * 60 * 1000,
  );
});
