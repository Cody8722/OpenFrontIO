// Behaviour pinned: mixed games (half the nations play the rules, half the
// network) are reproducible: who gets the network is fixed by the nation id and
// the gameID alone, the halves are balanced, and the same game replays tick for
// tick. NN_EVAL=1 plays the evidence runs on 54 fresh seeds (18 map x opening
// strata x 3): all rules, all network, and the mixed game in both assignments
// (the second swaps the roles, so every nation plays once with each policy).
// Output: .nn-nation-data/eval/<mode>/<gameID>.json
import { Difficulty, PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  AttackPolicy,
  RuleAttackPolicy,
} from "@openfront/engine/execution/utils/AttackPolicy";
import {
  NetworkAttackPolicy,
  newTakeoverStats,
} from "@openfront/engine/execution/utils/NetworkAttackPolicy";
import fs from "fs";
import path from "path";
import {
  BehaviorLog,
  DecisionLog,
  installSendProbe,
  SendLog,
  StrengthCounts,
  TurnLog,
} from "./util/NationBehaviorLog";
import { loadWorldNations, TraceSpec, traceWorld } from "./util/NationTrace";

const OUT = path.join(__dirname, "..", ".nn-nation-data", "eval");

type Mode = "rules" | "net" | "mixA" | "mixB";

/** FNV-1a over the whole string plus a finalizer, so every character mixes in. */
function mix(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Who gets the network in a mixed game: the first half by hash(id + gameID). */
function netNations(ids: string[], gameID: string, swap: boolean): Set<string> {
  const ranked = [...ids].sort(
    (a, b) => mix(`${a}|${gameID}`) - mix(`${b}|${gameID}`) || (a < b ? -1 : 1),
  );
  const first = new Set(ranked.slice(0, Math.ceil(ids.length / 2)));
  return swap ? new Set(ids.filter((i) => !first.has(i))) : first;
}

async function play(spec: TraceSpec, mode: Mode, detail: boolean) {
  installSendProbe();
  const ids = loadWorldNations(spec.nations, spec.map).map(
    (n) => n.playerInfo.id,
  );
  const useNet =
    mode === "net"
      ? new Set(ids)
      : mode === "rules"
        ? new Set<string>()
        : netNations(ids, spec.gameID, mode === "mixB");
  const stats = newTakeoverStats();
  const sends: SendLog[] = [];
  const turns: TurnLog[] = [];
  const decisions: DecisionLog[] = [];
  const strength: StrengthCounts = { decisions: 0, attacks: 0 };
  let idx = 0;
  const { result, game } = await traceWorld(
    spec,
    undefined,
    undefined,
    (nation, g) => {
      const id = nation.playerInfo.id;
      const inner: AttackPolicy = useNet.has(id)
        ? new NetworkAttackPolicy(g, id, stats)
        : new RuleAttackPolicy();
      return new BehaviorLog(
        inner,
        g,
        id,
        idx++,
        sends,
        turns,
        strength,
        detail ? decisions : undefined,
      );
    },
  );
  const nations = game
    .players()
    .filter((p) => p.type() === PlayerType.Nation)
    .map((p) => ({
      id: p.id(),
      net: useNet.has(p.id()),
      tiles: p.numTilesOwned(),
      troops: Math.round(Number(p.troops())),
      alive: p.isAlive(),
    }));
  return {
    chain: result.chain,
    attacksStarted: result.attacksStarted,
    nations,
    sends,
    turns,
    decisions,
    strength,
    stats,
  };
}

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

/** 18 strata x 3 fresh seeds (full, half, full nation count). */
function evalSpecs(): (TraceSpec & { opening: string })[] {
  const out: (TraceSpec & { opening: string })[] = [];
  for (const { map, nations } of MAPS) {
    for (const opening of ["normal", "rich"]) {
      [nations, Math.round(nations / 2), nations].forEach((n, i) => {
        const gameID = `${map.replace("real:", "")}-${opening}-n${n}-s${10 + i}`;
        out.push({
          label: gameID,
          gameID,
          map,
          difficulty: Difficulty.Hard,
          nations: n,
          ticks: 6000,
          opening,
          ...(opening === "rich"
            ? { startingGold: 1_000_000_000, goldMultiplier: 10 }
            : {}),
        });
      });
    }
  }
  return out;
}

describe("mixed games", () => {
  test("the assignment is fixed by id and gameID, balanced, and swappable", () => {
    const ids = loadWorldNations(25, "real:asia").map((n) => n.playerInfo.id);
    const a = netNations(ids, "g1", false);
    const b = netNations(ids, "g1", true);
    expect(a.size).toBe(13);
    expect(b.size).toBe(12);
    expect(ids.every((i) => a.has(i) !== b.has(i))).toBe(true);
    expect([...netNations(ids, "g1", false)]).toEqual([...a]);
    expect([...netNations(ids, "g2", false)]).not.toEqual([...a]);
  });

  test("a mixed game replays tick for tick and differs from the pure ones", async () => {
    const spec: TraceSpec = {
      label: "mix",
      gameID: "nn-mix-a",
      difficulty: Difficulty.Hard,
      nations: 40,
      ticks: 1500,
    };
    const a = await play(spec, "mixA", false);
    const b = await play(spec, "mixA", false);
    expect(b.chain).toBe(a.chain);
    const placed = loadWorldNations(40, undefined).length;
    expect(a.nations.filter((n) => n.net).length).toBe(Math.ceil(placed / 2));
    const rules = await play(spec, "rules", false);
    expect(a.chain).not.toBe(rules.chain);
  }, 300_000);
});

describe.skipIf(process.env.NN_EVAL !== "1")("evidence runs", () => {
  test(
    "54 fresh seeds: rules, network, mixed A, mixed B",
    async () => {
      const modes = (process.env.NN_EVAL_MODES ?? "rules,net,mixA,mixB").split(
        ",",
      ) as Mode[];
      for (const mode of modes) {
        const dir = path.join(OUT, mode);
        fs.mkdirSync(dir, { recursive: true });
        for (const s of evalSpecs()) {
          const file = path.join(dir, `${s.gameID}.json`);
          if (fs.existsSync(file)) continue;
          const pure = mode === "rules" || mode === "net";
          const out = await play(s, mode, pure);
          fs.writeFileSync(
            file,
            JSON.stringify({
              gameID: s.gameID,
              map: s.map,
              opening: s.opening,
              mode,
              ...out,
              ...(pure ? {} : { sends: [], turns: [] }),
            }),
          );
          process.stderr.write(
            `[eval] ${mode} ${s.gameID} attacks ${out.attacksStarted}\n`,
          );
        }
      }
    },
    12 * 60 * 60 * 1000,
  );
});
