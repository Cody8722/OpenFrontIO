// Behaviour pinned: the page side of the dev switch ?nationTiming=0.5.
// - it applies in a single-player game on a dev build only: public and
//   private rooms (lockstep) ignore it, and so do staging and production
// - a missing, empty or invalid value is no request, and the environment is
//   not even asked then
// The worker side (single-player only) is in tests/NationTimingDev.test.ts;
// the wiring into the init message is in tests/client/WorkerClientNationTiming.test.ts.
import { GameType } from "@openfront/engine-api/game/GameTypes";
import { GameEnv } from "@openfront/shared/configuration/Env";
import {
  nationTimingLogRequest,
  nationTimingRequest,
} from "../../src/client/DevNationTiming";

const dev = () => GameEnv.Dev;

describe("nationTimingRequest", () => {
  test("a single-player game on a dev build takes it", () => {
    expect(
      nationTimingRequest("?nationTiming=0.5", GameType.Singleplayer, dev),
    ).toBe(0.5);
    expect(
      nationTimingRequest("?x=1&nationTiming=0", GameType.Singleplayer, dev),
    ).toBe(0);
  });

  test.each([GameType.Public, GameType.Private])(
    "a %s room ignores it",
    (gameType) => {
      expect(nationTimingRequest("?nationTiming=0.5", gameType, dev)).toBe(
        undefined,
      );
    },
  );

  test.each([GameEnv.Preprod, GameEnv.Prod])(
    "a build with env %s ignores it",
    (env) => {
      expect(
        nationTimingRequest(
          "?nationTiming=0.5",
          GameType.Singleplayer,
          () => env,
        ),
      ).toBe(undefined);
    },
  );

  test.each(["", "?nationTiming", "?nationTiming=", "?nationTiming=abc"])(
    "%j is no request, and the environment is not asked",
    (search) => {
      const env = vi.fn(dev);
      expect(nationTimingRequest(search, GameType.Singleplayer, env)).toBe(
        undefined,
      );
      expect(env).not.toHaveBeenCalled();
    },
  );

  test.each(["-0.1", "1", "1.5", "NaN", "Infinity"])(
    "spread %s is out of range",
    (value) => {
      expect(
        nationTimingRequest(
          `?nationTiming=${value}`,
          GameType.Singleplayer,
          dev,
        ),
      ).toBe(undefined);
    },
  );
});

describe("nationTimingLogRequest", () => {
  test("a single-player game on a dev build with =1 asks for the log", () => {
    expect(
      nationTimingLogRequest(
        "?nationTiming=0.5&nationTimingLog=1",
        GameType.Singleplayer,
        dev,
      ),
    ).toBe(true);
  });

  test.each([GameType.Public, GameType.Private])(
    "a %s room ignores it",
    (gameType) => {
      expect(nationTimingLogRequest("?nationTimingLog=1", gameType, dev)).toBe(
        undefined,
      );
    },
  );

  test.each([GameEnv.Preprod, GameEnv.Prod])(
    "a build with env %s ignores it",
    (env) => {
      expect(
        nationTimingLogRequest(
          "?nationTimingLog=1",
          GameType.Singleplayer,
          () => env,
        ),
      ).toBe(undefined);
    },
  );

  test.each([
    "",
    "?nationTimingLog",
    "?nationTimingLog=0",
    "?nationTimingLog=true",
  ])("%j is no request, and the environment is not asked", (search) => {
    const env = vi.fn(dev);
    expect(nationTimingLogRequest(search, GameType.Singleplayer, env)).toBe(
      undefined,
    );
    expect(env).not.toHaveBeenCalled();
  });
});
