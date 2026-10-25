// The features the engine computes (AttackFeatures, shared by the recorder and
// the network policies) equal the ones recorded in the collected data: the
// same games are played again and every recorded row must come out identical.
// Skipped when the collected data is not on this machine.
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import fs from "fs";
import os from "os";
import path from "path";
import { DecisionRecorder } from "./util/NationRecorder";
import { traceWorld } from "./util/NationTrace";

const DATA = path.join(__dirname, "..", ".nn-nation-data");
const GAMES = [
  "britannia-normal-n10-s0",
  "britannia-rich-n10-s0",
  "asia-normal-n25-s0",
  "caribbean-normal-n17-s0",
];
const have = fs.existsSync(path.join(DATA, "games.jsonl"));

describe.skipIf(!have)("engine features equal the recorded features", () => {
  test.each(GAMES)(
    "%s replays to identical rows",
    async (gameID) => {
      const m = /^(.+)-(normal|rich)-n(\d+)-s\d+$/.exec(gameID)!;
      const map = m[1] === "world" ? "world" : `real:${m[1]}`;
      const file = path.join(
        os.tmpdir(),
        `nn-parity-${process.pid}-${gameID}.jsonl`,
      );
      fs.rmSync(file, { force: true });
      let idx = 0;
      const recorders: DecisionRecorder[] = [];
      await traceWorld(
        {
          label: gameID,
          gameID,
          map,
          difficulty: Difficulty.Hard,
          nations: Number(m[3]),
          ticks: 6000,
          ...(m[2] === "rich"
            ? { startingGold: 1_000_000_000, goldMultiplier: 10 }
            : {}),
        },
        undefined,
        undefined,
        (nation, g) => {
          const r = new DecisionRecorder(
            g,
            nation.playerInfo.id,
            idx++,
            gameID,
            file,
            "full",
          );
          recorders.push(r);
          return r;
        },
      );
      recorders.forEach((r) => r.flush());
      const got = fs.readFileSync(file, "utf8").split("\n");
      const want = fs
        .readFileSync(path.join(DATA, "raw", `${gameID}.jsonl`), "utf8")
        .split("\n");
      fs.rmSync(file, { force: true });
      expect(got.length).toBe(want.length);
      for (let i = 0; i < want.length; i++) {
        if (got[i] !== want[i]) {
          throw new Error(`row ${i} differs:\n${got[i]}\n${want[i]}`);
        }
      }
      expect(want.length).toBeGreaterThan(100);
    },
    600_000,
  );
});
