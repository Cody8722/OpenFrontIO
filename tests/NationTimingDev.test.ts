// Behaviour pinned: the dev switch for jittered nation timing (page URL
// ?nationTiming=0.5 -> init message -> worker -> Executor).
// - the worker takes it in single-player games only; a public or private
//   (multiplayer, lockstep) game ignores it, and a request never outlives its game
// - an invalid spread is ignored
// - the nations a game builds get the timing when it is on, none when it is off
// The page side (non-production only) is in tests/client/DevNationTiming.test.ts.
import { GameType } from "@openfront/engine-api/game/GameTypes";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import {
  configureDevNationTiming,
  devNationTiming,
  setDevNationTiming,
} from "@openfront/engine/execution/nation/NationTiming";
import { loadWorldNations } from "./util/NationTrace";
import { setup } from "./util/Setup";

afterEach(() => setDevNationTiming(undefined));

describe("dev nation timing switch (engine side)", () => {
  test("single-player takes a valid spread", () => {
    configureDevNationTiming(GameType.Singleplayer, 0.5);
    expect(devNationTiming()).toEqual({ spread: 0.5 });
    configureDevNationTiming(GameType.Singleplayer, 0);
    expect(devNationTiming()).toEqual({ spread: 0 });
  });

  test.each([GameType.Public, GameType.Private])(
    "a %s game ignores the request",
    (gameType) => {
      configureDevNationTiming(gameType, 0.5);
      expect(devNationTiming()).toBeUndefined();
    },
  );

  test("a game without a request clears what an earlier game left", () => {
    configureDevNationTiming(GameType.Singleplayer, 0.5);
    configureDevNationTiming(GameType.Public, 0.5);
    expect(devNationTiming()).toBeUndefined();
    configureDevNationTiming(GameType.Singleplayer, 0.5);
    configureDevNationTiming(GameType.Singleplayer, undefined);
    expect(devNationTiming()).toBeUndefined();
  });

  test.each([-0.1, 1, 2, NaN, Infinity])("spread %s is ignored", (spread) => {
    configureDevNationTiming(GameType.Singleplayer, spread);
    expect(devNationTiming()).toBeUndefined();
  });

  test("the nations of a game get the timing only when the switch is on", async () => {
    const game = await setup(
      "world",
      {},
      [],
      undefined,
      undefined,
      false,
      loadWorldNations(6),
    );
    const timed = (): boolean[] =>
      new Executor(game, "dev-timing", undefined)
        .nationExecutions()
        .map(
          (e) => (e as unknown as { timing?: unknown }).timing !== undefined,
        );

    expect(timed().every((t) => !t)).toBe(true);
    configureDevNationTiming(GameType.Singleplayer, 0.5);
    const on = timed();
    expect(on.length).toBe(6);
    expect(on.every((t) => t)).toBe(true);
    configureDevNationTiming(GameType.Public, 0.5);
    expect(timed().every((t) => !t)).toBe(true);
  });
});
