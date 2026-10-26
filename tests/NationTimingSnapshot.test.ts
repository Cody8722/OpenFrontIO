// Behaviour pinned: a nation's snapshot record upgrades from version 1 (no
// timing) to version 2 and keeps playing exactly as the old build would have;
// with timing on, saving mid-game and restoring plays on tick for tick like the
// uninterrupted game.
//
// tests/testdata/nn-nation/nation-v1.* is a real version-1 snapshot written by
// the build before nation timing existed (NN_TIMING_FIXTURE=1 on that build),
// with the per-tick state hashes that build produced when playing on.
import {
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { Game } from "@openfront/engine/game/Game";
import { snapshotGame } from "@openfront/engine/snapshot/GameSnapshot";
import fs from "fs";
import path from "path";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip, restoreTestGame } from "./util/Snapshot";

const MAP = "world";
const GAME_ID = "snapshot_timing";
const FIXTURE = path.join(__dirname, "testdata", "nn-nation");

const NATIONS: [string, number, number][] = [
  ["United Kingdom", 925, 186],
  ["France", 958, 220],
  ["Spain", 908, 264],
  ["Germany", 997, 205],
  ["Italy", 1004, 250],
  ["Poland", 1046, 193],
  ["Algeria", 918, 342],
  ["Morocco", 853, 373],
];

async function nationGame(timing?: { spread: number }): Promise<Game> {
  const nations = NATIONS.map(
    ([name, x, y], i) =>
      new Nation(
        new Cell(x, y),
        new PlayerInfo(name, PlayerType.Nation, null, `nation_${i}`),
      ),
  );
  const game = await setup(
    MAP,
    {
      difficulty: Difficulty.Hard,
      instantBuild: true,
      startingGold: 30_000_000,
      goldMultiplier: 20,
    },
    [],
    undefined,
    undefined,
    false,
    nations,
  );
  for (const n of game.nations()) {
    // timing is the fourth argument; the build that wrote the fixture has no such parameter
    game.addExecution(
      timing === undefined
        ? new NationExecution(GAME_ID, n)
        : new NationExecution(GAME_ID, n, undefined, timing),
    );
  }
  return game;
}

function run(game: Game, ticks: number): number[] {
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    game.executeNextTick();
    hashes.push((game as unknown as { hash(): number }).hash());
  }
  return hashes;
}

async function playedGame(timing?: { spread: number }): Promise<Game> {
  const game = await nationGame(timing);
  run(game, 15);
  game.endSpawnPhase();
  run(game, 300);
  return game;
}

describe.skipIf(process.env.NN_TIMING_FIXTURE !== "1")("fixture writer", () => {
  test("writes the version-1 snapshot and the hashes that follow it", async () => {
    const game = await playedGame();
    fs.mkdirSync(FIXTURE, { recursive: true });
    fs.writeFileSync(
      path.join(FIXTURE, "nation-v1.snapshot"),
      snapshotGame(game),
    );
    fs.writeFileSync(
      path.join(FIXTURE, "nation-v1.hashes.json"),
      JSON.stringify({ map: MAP, after: run(game, 150) }),
    );
  }, 300_000);
});

describe("nation timing and snapshots", () => {
  test("a version-1 snapshot upgrades and plays on exactly as before", async () => {
    const bytes = fs.readFileSync(path.join(FIXTURE, "nation-v1.snapshot"));
    const want = JSON.parse(
      fs.readFileSync(path.join(FIXTURE, "nation-v1.hashes.json"), "utf8"),
    ) as { map: string; after: number[] };
    const game = await restoreTestGame(new Uint8Array(bytes), want.map);
    expect(run(game, want.after.length)).toEqual(want.after);
  }, 300_000);

  test.each([0, 0.5])(
    "timing spread %s: save mid-game and restore plays on tick for tick",
    async (spread) => {
      const game = await playedGame({ spread });
      await expectSnapshotRoundTrip(game, MAP, 120);
      run(game, 150);
      await expectSnapshotRoundTrip(game, MAP, 120);
    },
    300_000,
  );
});
