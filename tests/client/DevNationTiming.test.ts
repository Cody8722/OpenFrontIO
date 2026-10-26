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
  captureDevSearch,
  devSearch,
  nationTimingLogRequest,
  nationTimingRequest,
} from "../../src/client/DevNationTiming";

const dev = () => GameEnv.Dev;

// The real bug: a single-player start rewrites the address bar to "/" (a
// joined game to /w0/game/<id>) before WorkerClient reads it. The values are
// taken at page load, so they must survive that.
describe("captureDevSearch: the query string survives the address-bar rewrite", () => {
  afterEach(() => {
    captureDevSearch("", dev);
    window.history.replaceState({}, "", "/");
  });

  test("both switches are still read after history.replaceState drops the query", () => {
    window.history.replaceState({}, "", "/?nationTiming=0.5&nationTimingLog=1");
    captureDevSearch(window.location.search, dev);
    window.history.replaceState(null, "", "/w0/game/abcd1234");
    expect(window.location.search).toBe("");

    expect(nationTimingRequest(devSearch(), GameType.Singleplayer, dev)).toBe(
      0.5,
    );
    expect(
      nationTimingLogRequest(devSearch(), GameType.Singleplayer, dev),
    ).toBe(true);
  });

  test("without the parameters both answer undefined", () => {
    window.history.replaceState({}, "", "/?x=1");
    captureDevSearch(window.location.search, dev);
    window.history.replaceState(null, "", "/");
    expect(devSearch()).toBe("");
    expect(
      nationTimingRequest(devSearch(), GameType.Singleplayer, dev),
    ).toBeUndefined();
    expect(
      nationTimingLogRequest(devSearch(), GameType.Singleplayer, dev),
    ).toBeUndefined();
  });

  test("a later capture replaces the earlier one", () => {
    captureDevSearch("?nationTiming=0.5", dev);
    captureDevSearch("", dev);
    expect(devSearch()).toBe("");
  });

  test.each([GameEnv.Preprod, GameEnv.Prod])(
    "env %s records nothing",
    (env) => {
      captureDevSearch("?nationTiming=0.5&nationTimingLog=1", () => env);
      expect(devSearch()).toBe("");
    },
  );

  test("a query without the switches does not even ask the environment", () => {
    const env = vi.fn(dev);
    captureDevSearch("?lang=en", env);
    captureDevSearch(undefined, env);
    expect(env).not.toHaveBeenCalled();
    expect(devSearch()).toBe("");
  });

  test("an environment that cannot be read records nothing", () => {
    captureDevSearch("?nationTiming=0.5", () => {
      throw new Error("Missing BOOTSTRAP_CONFIG");
    });
    expect(devSearch()).toBe("");
  });

  test("a multiplayer room still ignores what was captured", () => {
    captureDevSearch("?nationTiming=0.5&nationTimingLog=1", dev);
    for (const gameType of [GameType.Public, GameType.Private]) {
      expect(nationTimingRequest(devSearch(), gameType, dev)).toBeUndefined();
      expect(
        nationTimingLogRequest(devSearch(), gameType, dev),
      ).toBeUndefined();
    }
  });
});

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
