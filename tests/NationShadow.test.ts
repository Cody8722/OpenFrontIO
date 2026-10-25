// Behaviour pinned: shadow mode (the network scores every decision of the
// strength-based block next to the rules, recording and never acting) does not
// change the game: same tick-level hash chain with it on or off, no extra random
// draws, and the same records when the same seed is played twice.
//
// Default run: one short game. NN_SHADOW=1 adds the 6000-tick neutrality run
// (3 maps x normal/rich) and NN_SHADOW_COLLECT=1 plays the validation games and
// writes what the network chose to .nn-nation-data/shadow/<gameID>.jsonl.
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import {
  NetworkShadowPolicy,
  ShadowRecord,
} from "@openfront/engine/execution/utils/NetworkShadowPolicy";
import fs from "fs";
import path from "path";
import { TraceSpec, traceWorld } from "./util/NationTrace";

const DATA = path.join(__dirname, "..", ".nn-nation-data");

const spec = (over: Partial<TraceSpec> = {}): TraceSpec => ({
  label: "shadow",
  gameID: "nn-shadow-a",
  difficulty: Difficulty.Hard,
  nations: 40,
  ticks: 1500,
  ...over,
});

async function play(s: TraceSpec, shadow: boolean) {
  const records: ShadowRecord[][] = [];
  const result = (
    await traceWorld(
      s,
      undefined,
      undefined,
      shadow
        ? (nation, game) => {
            const mine: ShadowRecord[] = [];
            records.push(mine);
            return new NetworkShadowPolicy(game, nation.playerInfo.id, (r) =>
              mine.push(r),
            );
          }
        : undefined,
    )
  ).result;
  return { chain: result.chain, checkpoints: result.checkpoints, records };
}

describe("shadow mode", () => {
  test("changes nothing and replays the same records", async () => {
    const off = await play(spec(), false);
    const on = await play(spec(), true);
    const again = await play(spec(), true);
    expect(on.checkpoints.findIndex((c, i) => c !== off.checkpoints[i])).toBe(
      -1,
    );
    expect(on.chain).toBe(off.chain);
    expect(again.records).toEqual(on.records);
    const all = on.records.flat();
    expect(all.length).toBeGreaterThan(50);
    expect(all.every((r) => r.net >= -1 && r.net <= r.candidates)).toBe(true);
  }, 300_000);
});

describe.skipIf(process.env.NN_SHADOW !== "1")(
  "shadow mode, 6000 ticks",
  () => {
    test.each([
      ["world", 40],
      ["real:asia", 25],
      ["real:britannia", 20],
    ])(
      "hash chains match with shadow on and off on %s (normal and rich)",
      async (map, nations) => {
        for (const rich of [false, true]) {
          const s = spec({
            gameID: `shadow-${map}-${rich}`,
            map,
            nations,
            ticks: 6000,
            ...(rich
              ? { startingGold: 1_000_000_000, goldMultiplier: 10 }
              : {}),
          });
          const off = await play(s, false);
          const on = await play(s, true);
          const bad = on.checkpoints.findIndex(
            (c, i) => c !== off.checkpoints[i],
          );
          process.stderr.write(
            `[shadow] ${map} ${rich ? "rich" : "normal"} first bad checkpoint ${bad}\n`,
          );
          expect(bad).toBe(-1);
          expect(on.chain).toBe(off.chain);
        }
      },
      60 * 60 * 1000,
    );
  },
);

describe.skipIf(process.env.NN_SHADOW_COLLECT !== "1")(
  "shadow collection",
  () => {
    test(
      "plays the validation games and records the network's choices",
      async () => {
        const games = fs
          .readFileSync(path.join(DATA, "games.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const split = JSON.parse(
          fs.readFileSync(path.join(DATA, "split.json"), "utf8"),
        );
        const set = process.env.NN_SHADOW_SET ?? "val";
        const out = path.join(DATA, "shadow");
        fs.mkdirSync(out, { recursive: true });
        for (const g of games) {
          if (split[g.gameID] !== set) continue;
          const file = path.join(out, `${g.gameID}.jsonl`);
          if (fs.existsSync(file)) continue;
          const m = /^(.+)-(normal|rich)-n(\d+)-s\d+$/.exec(g.gameID)!;
          const { records } = await play(
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
            true,
          );
          // one line per decision, in nation order then play order
          const lines = records.flatMap((mine, n) =>
            mine.map((r) => JSON.stringify({ n, ...r })),
          );
          fs.writeFileSync(file, lines.join("\n") + "\n");
          process.stderr.write(
            `[shadow] ${g.gameID} ${lines.length} decisions\n`,
          );
        }
      },
      6 * 60 * 60 * 1000,
    );
  },
);
