// Behaviour pinned: with timing off the games are what they were; the evidence
// runs for phase A (jittered thinks) are reproducible. NN_TIMING=1 plays them:
// the old lattice and each spread on the 54 fresh seeds (rules only), and mixed
// games where half the nations (both ways round) think with spread 0.5.
// Output: .nn-nation-data/timing/<config>/<gameID>.json, everything the report
// needs: think ticks (turns), each nation's lattice, action counts by type.
import { Difficulty, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { RuleAttackPolicy } from "@openfront/engine/execution/utils/AttackPolicy";
import fs from "fs";
import path from "path";
import {
  actionCounts,
  installActionProbe,
  resetActionCounts,
} from "./util/NationActionProbe";
import {
  BehaviorLog,
  SendLog,
  StrengthCounts,
  TurnLog,
} from "./util/NationBehaviorLog";
import { evalSpecs, halfOf } from "./util/NationSeeds";
import {
  loadWorldNations,
  schedule,
  TraceSpec,
  traceWorld,
} from "./util/NationTrace";

const OUT = path.join(__dirname, "..", ".nn-nation-data", "timing");
const MIX_SPREAD = 0.5;

type Config =
  | "legacy"
  | "s000"
  | "s025"
  | "s050"
  | "s075"
  | "mix050A"
  | "mix050B";
const SPREADS: Record<string, number | undefined> = {
  legacy: undefined,
  s000: 0,
  s025: 0.25,
  s050: 0.5,
  s075: 0.75,
};

async function play(spec: TraceSpec, config: Config) {
  installActionProbe();
  resetActionCounts();
  const ids = loadWorldNations(spec.nations, spec.map).map(
    (n) => n.playerInfo.id,
  );
  const timed = config.startsWith("mix")
    ? halfOf(ids, spec.gameID, config === "mix050B")
    : new Set<string>();
  const sends: SendLog[] = [];
  const turns: TurnLog[] = [];
  const strength: StrengthCounts = { decisions: 0, attacks: 0 };
  let idx = 0;
  const { result, game, executions } = await traceWorld(
    spec,
    undefined,
    undefined,
    (nation, g) =>
      new BehaviorLog(
        new RuleAttackPolicy(),
        g,
        nation.playerInfo.id,
        idx++,
        sends,
        turns,
        strength,
      ),
    (nation) => {
      if (config.startsWith("mix")) {
        return timed.has(nation.playerInfo.id)
          ? { spread: MIX_SPREAD }
          : undefined;
      }
      const s = SPREADS[config];
      return s === undefined ? undefined : { spread: s };
    },
  );
  const lattice = game.nations().map((n, i) => ({
    id: n.playerInfo.id,
    ...schedule(executions[i]),
  }));
  return {
    ticks: spec.ticks,
    chain: result.chain,
    attacksStarted: result.attacksStarted,
    nations: game
      .players()
      .filter((p) => p.type() === PlayerType.Nation)
      .map((p) => ({
        id: p.id(),
        timed: timed.has(p.id()),
        tiles: p.numTilesOwned(),
        troops: Math.round(Number(p.troops())),
        alive: p.isAlive(),
      })),
    lattice,
    turns,
    nSends: sends.length,
    nStrengthSends: sends.filter((s) => s.strength).length,
    strength,
    actions: actionCounts(),
  };
}

describe("nation timing runs", () => {
  test("the action probe changes nothing and counts what nations send", async () => {
    const spec: TraceSpec = {
      label: "probe",
      gameID: "nn-probe-a",
      difficulty: Difficulty.Hard,
      nations: 30,
      ticks: 1500,
    };
    const plain = await traceWorld(spec);
    const probed = await play(spec, "legacy");
    expect(probed.chain).toBe(plain.result.chain);
    const total = Object.values(probed.actions).flatMap((a) =>
      Object.values(a),
    );
    expect(total.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
    // a spread of 0 plays the lattice: same chain, same actions
    const zero = await play(spec, "s000");
    expect(zero.chain).toBe(probed.chain);
    expect(zero.actions).toEqual(probed.actions);
  }, 300_000);
});

describe.skipIf(process.env.NN_TIMING !== "1")("timing evidence runs", () => {
  test(
    "plays the fresh seeds under every configuration",
    async () => {
      const configs = (
        process.env.NN_TIMING_CONFIGS ??
        "legacy,s050,s025,s075,mix050A,mix050B,s000"
      ).split(",") as Config[];
      for (const config of configs) {
        const dir = path.join(OUT, config);
        fs.mkdirSync(dir, { recursive: true });
        // the spread-0 check needs only a few games: it must equal the lattice
        const specs =
          config === "s000"
            ? evalSpecs().filter((_, i) => i % 9 === 0)
            : evalSpecs();
        for (const s of specs) {
          const file = path.join(dir, `${s.gameID}.json`);
          if (fs.existsSync(file)) continue;
          const out = await play(s, config);
          fs.writeFileSync(
            file,
            JSON.stringify({
              gameID: s.gameID,
              map: s.map,
              opening: s.opening,
              config,
              ...out,
            }),
          );
          process.stderr.write(
            `[timing] ${config} ${s.gameID} attacks ${out.attacksStarted}\n`,
          );
        }
      }
    },
    12 * 60 * 60 * 1000,
  );
});
