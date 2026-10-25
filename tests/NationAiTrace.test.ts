// Behaviour pinned by the AI policy refactor: with the default (rule) policy the
// nations play tick-for-tick as before. Slow, so it only runs with NN_TRACE=1;
// NN_TRACE_RECORD=1 rewrites the baseline (record it on unmodified engine code).
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TraceResult, TraceSpec, traceWorld } from "./util/NationTrace";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, "testdata/nn-nation/baseline-trace.json");

const SPECS: TraceSpec[] = [
  // 10 minutes (6000 ticks) of Hard nations, two seeds
  {
    label: "hard-a",
    gameID: "nn-seed-a",
    difficulty: Difficulty.Hard,
    nations: 40,
    ticks: 6000,
  },
  {
    label: "hard-b",
    gameID: "nn-seed-b",
    difficulty: Difficulty.Hard,
    nations: 40,
    ticks: 6000,
  },
  // rich start: exercises the city-troop / high-gold branches
  {
    label: "hard-rich",
    gameID: "nn-seed-c",
    difficulty: Difficulty.Hard,
    nations: 40,
    ticks: 6000,
    startingGold: 1_000_000_000,
    goldMultiplier: 10,
  },
  // other difficulties must be untouched too
  {
    label: "medium",
    gameID: "nn-seed-a",
    difficulty: Difficulty.Medium,
    nations: 40,
    ticks: 3000,
  },
  {
    label: "impossible",
    gameID: "nn-seed-a",
    difficulty: Difficulty.Impossible,
    nations: 40,
    ticks: 3000,
  },
];

const enabled = process.env.NN_TRACE === "1";

describe.skipIf(!enabled)("nation AI trace (tick-level equivalence)", () => {
  const record = process.env.NN_TRACE_RECORD === "1";
  const baseline: Record<string, TraceResult> =
    !record && fs.existsSync(BASELINE)
      ? JSON.parse(fs.readFileSync(BASELINE, "utf8"))
      : {};
  const recorded: Record<string, TraceResult> = {};

  for (const spec of SPECS) {
    test(
      spec.label,
      async () => {
        const cap = Number(process.env.NN_TRACE_TICKS ?? 0);
        const t0 = Date.now();
        const { result } = await traceWorld(
          cap > 0 ? { ...spec, ticks: Math.min(spec.ticks, cap) } : spec,
        );
        process.stderr.write(
          `[trace] ${spec.label} ${result.ticks} ticks ${Date.now() - t0} ms ` +
            `heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB ` +
            `attacks ${result.attacksStarted}\n`,
        );
        recorded[spec.label] = result;
        if (record) {
          expect(result.attacksStarted).toBeGreaterThan(0);
          return;
        }
        const want = baseline[spec.label];
        expect(want, `no baseline for ${spec.label}`).toBeDefined();
        // first diverging checkpoint is reported before the chain hash
        const firstBad = result.checkpoints.findIndex(
          (c, i) => c !== want.checkpoints[i],
        );
        expect(firstBad, "first diverging 300-tick checkpoint").toBe(-1);
        expect(result.chain).toBe(want.chain);
        expect(result.attacksStarted).toBe(want.attacksStarted);
        expect(result.finalTroops).toBe(want.finalTroops);
        expect(result.finalTiles).toBe(want.finalTiles);
      },
      30 * 60 * 1000,
    );
  }

  afterAll(() => {
    if (!record) return;
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(recorded, null, 1) + "\n");
  });
});
