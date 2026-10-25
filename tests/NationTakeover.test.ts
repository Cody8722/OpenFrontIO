// Behaviour pinned: takeover mode (the network picks the target of the
// strength-based block, the rules keep everything else) is deterministic: the
// same seed replays tick for tick. Default run: one short game. NN_TAKEOVER=1
// adds the 6000-tick replay (3 maps x normal/rich) and a rules-vs-network run
// of the validation games, written to .nn-nation-data/takeover/<mode>/<id>.json.
import { Difficulty, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  AttackPolicy,
  RuleAttackPolicy,
} from "@openfront/engine/execution/utils/AttackPolicy";
import {
  NetworkAttackPolicy,
  newTakeoverStats,
  TakeoverStats,
} from "@openfront/engine/execution/utils/NetworkAttackPolicy";
import fs from "fs";
import path from "path";
import {
  BehaviorLog,
  SendLog,
  StrengthCounts,
  TurnLog,
} from "./util/NationBehaviorLog";
import { TraceSpec, traceWorld } from "./util/NationTrace";

const DATA = path.join(__dirname, "..", ".nn-nation-data");

const spec = (over: Partial<TraceSpec> = {}): TraceSpec => ({
  label: "takeover",
  gameID: "nn-takeover-a",
  difficulty: Difficulty.Hard,
  nations: 40,
  ticks: 1500,
  ...over,
});

type Mode = "rules" | "net";

async function play(s: TraceSpec, mode: Mode) {
  const stats = newTakeoverStats();
  const sends: SendLog[] = [];
  const turns: TurnLog[] = [];
  const strength: StrengthCounts = { decisions: 0, attacks: 0 };
  let idx = 0;
  const { result, game } = await traceWorld(
    s,
    undefined,
    undefined,
    (nation, g) => {
      const inner: AttackPolicy =
        mode === "net"
          ? new NetworkAttackPolicy(g, nation.playerInfo.id, stats)
          : new RuleAttackPolicy();
      return new BehaviorLog(
        inner,
        g,
        nation.playerInfo.id,
        idx++,
        sends,
        turns,
        strength,
      );
    },
  );
  const nations = game
    .players()
    .filter((p) => p.type() === PlayerType.Nation)
    .map((p) => ({
      tiles: p.numTilesOwned(),
      troops: Math.round(p.troops()),
      alive: p.isAlive(),
    }));
  return {
    chain: result.chain,
    checkpoints: result.checkpoints,
    attacksStarted: result.attacksStarted,
    nations,
    sends,
    turns,
    strength,
    stats: stats as TakeoverStats,
  };
}

describe("takeover mode", () => {
  test("the same seed replays tick for tick", async () => {
    const a = await play(spec(), "net");
    const b = await play(spec(), "net");
    expect(b.checkpoints.findIndex((c, i) => c !== a.checkpoints[i])).toBe(-1);
    expect(b.chain).toBe(a.chain);
    expect(b.sends).toEqual(a.sends);
    expect(b.stats).toEqual(a.stats);
    expect(a.stats.decisions).toBeGreaterThan(20);
    expect(a.stats.crownTried).toBe(a.stats.netNone);
  }, 300_000);
});

describe.skipIf(process.env.NN_TAKEOVER !== "1")(
  "takeover mode, 6000 ticks",
  () => {
    test.each([
      ["world", 40],
      ["real:asia", 25],
      ["real:britannia", 20],
    ])(
      "the same seed gives the same hash chain on %s (normal and rich)",
      async (map, nations) => {
        for (const rich of [false, true]) {
          const s = spec({
            gameID: `takeover-${map}-${rich}`,
            map,
            nations,
            ticks: 6000,
            ...(rich
              ? { startingGold: 1_000_000_000, goldMultiplier: 10 }
              : {}),
          });
          const a = await play(s, "net");
          const b = await play(s, "net");
          const bad = b.checkpoints.findIndex((c, i) => c !== a.checkpoints[i]);
          process.stderr.write(
            `[takeover] ${map} ${rich ? "rich" : "normal"} first bad checkpoint ${bad}, ` +
              `attacks ${a.attacksStarted}, ${JSON.stringify(a.stats)}\n`,
          );
          expect(bad).toBe(-1);
          expect(b.chain).toBe(a.chain);
        }
      },
      60 * 60 * 1000,
    );

    test(
      "rules and network on the validation seeds",
      async () => {
        const games = fs
          .readFileSync(path.join(DATA, "games.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const split = JSON.parse(
          fs.readFileSync(path.join(DATA, "split.json"), "utf8"),
        );
        for (const mode of ["rules", "net"] as Mode[]) {
          const dir = path.join(DATA, "takeover", mode);
          fs.mkdirSync(dir, { recursive: true });
          for (const g of games) {
            if (split[g.gameID] !== (process.env.NN_TAKEOVER_SET ?? "val")) {
              continue;
            }
            const file = path.join(dir, `${g.gameID}.json`);
            if (fs.existsSync(file)) continue;
            const m = /^(.+)-(normal|rich)-n(\d+)-s\d+$/.exec(g.gameID)!;
            const out = await play(
              {
                label: g.gameID,
                gameID: g.gameID,
                map: g.map,
                difficulty: Difficulty.Hard,
                nations: Number(m[3]),
                ticks: g.ticks,
                ...(m[2] === "rich"
                  ? { startingGold: 1_000_000_000, goldMultiplier: 10 }
                  : {}),
              },
              mode,
            );
            fs.writeFileSync(
              file,
              JSON.stringify({
                gameID: g.gameID,
                map: g.map,
                opening: g.opening,
                mode,
                ...out,
              }),
            );
            process.stderr.write(
              `[takeover] ${mode} ${g.gameID} attacks ${out.attacksStarted}\n`,
            );
          }
        }
      },
      6 * 60 * 60 * 1000,
    );
  },
);
