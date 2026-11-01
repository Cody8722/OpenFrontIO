// Behaviour pinned: the dev diagnostic log of nation wake-ups ([NationTiming]).
// - turning it on changes nothing: the hash chain of the same game is the same
//   with the log on and off, on the old lattice and with jittered timing
// - it is on only for a single-player game that asked; otherwise no logger
// - one line per wake (tick, name, gap since the last wake, outcome), a start
//   line, and a statistics line every 3000 ticks with the right numbers
// - the decorator passes every call to the real policy unchanged
// The page side is in tests/client/DevNationTiming.test.ts.
import {
  Difficulty,
  GameType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { setDevNationTiming } from "@openfront/engine/execution/nation/NationTiming";
import {
  configureDevNationTimingLog,
  devNationTimingLogger,
  NationTimingLogger,
  worldOf,
} from "@openfront/engine/execution/nation/NationTimingLog";
import type {
  AttackPolicy,
  EngageContext,
} from "@openfront/engine/execution/utils/AttackPolicy";
import type { Game } from "@openfront/engine/game/Game";
import { loadWorldNations, TraceSpec, traceWorld } from "./util/NationTrace";
import { setup } from "./util/Setup";

afterEach(() => {
  configureDevNationTimingLog(GameType.Public, undefined);
  setDevNationTiming(undefined);
});

const spec: TraceSpec = {
  label: "timing-log",
  gameID: "nn-log-a",
  difficulty: Difficulty.Hard,
  nations: 30,
  ticks: 3600,
};

async function chainWith(
  log: string[] | null,
  spread: number | undefined,
  mode: true | "stats" = true,
): Promise<string> {
  if (log === null) {
    configureDevNationTimingLog(GameType.Singleplayer, false);
  } else {
    configureDevNationTimingLog(GameType.Singleplayer, mode, (l) =>
      log.push(l),
    );
  }
  const { result } = await traceWorld(
    spec,
    undefined,
    undefined,
    undefined,
    spread === undefined ? undefined : { spread },
  );
  return result.chain;
}

describe("nation timing log: changes nothing", () => {
  test.each([undefined, 0.5])(
    "same hash chain with the log on and off (spread %s)",
    async (spread) => {
      const lines: string[] = [];
      const off = await chainWith(null, spread);
      const on = await chainWith(lines, spread);
      expect(on).toBe(off);
      const wakes = lines.filter((l) => / 間隔=/.test(l));
      expect(wakes.length).toBeGreaterThan(300);
      expect(lines.every((l) => l.startsWith("[NationTiming] "))).toBe(true);
      expect(lines.some((l) => l.includes(" 統計 "))).toBe(true);
      checkNewFields(lines);
    },
    300_000,
  );

  test("stats-only mode: same hash chain, and no line per wake", async () => {
    const off = await chainWith(null, 0.5);
    const lines: string[] = [];
    const on = await chainWith(lines, 0.5, "stats");
    expect(on).toBe(off);
    expect(lines.some((l) => / 間隔=\d+刻| 間隔=首次/.test(l))).toBe(false);
    expect(lines.filter((l) => l.includes(" 統計 ")).length).toBeGreaterThan(0);
    expect(
      lines.every((l) => l.includes(" 開始 ") || l.includes(" 統計 ")),
    ).toBe(true);
  }, 300_000);
});

// The new statistics fields against what the scenario really did: for every
// window the number of distinct nations it printed per-wake lines for ==
// 醒來國家數 (a wake's line is printed after the statistics line that its own
// tick may trigger, so the lines between two statistics lines are exactly that
// window's wakes), and 存活國家 is a number between 1 and the 30 nations (the
// scenario builds its nations without the Executor, so it has no start line;
// that one is compared character by character in the start-line test).
function checkNewFields(lines: string[]) {
  let names = new Set<string>();
  let windows = 0;
  for (const l of lines) {
    const w = / t=\d+ (.+?) 間隔=/.exec(l);
    if (w) names.add(w[1]);
    const s = / 統計 .*存活國家=(\d+) 醒來國家數=(\d+)/.exec(l);
    if (s) {
      windows++;
      expect(+s[2]).toBe(names.size);
      expect(+s[1]).toBeGreaterThanOrEqual(1);
      expect(+s[1]).toBeLessThanOrEqual(30);
      names = new Set();
    }
  }
  expect(windows).toBeGreaterThan(0);
}

describe("nation timing log: switch", () => {
  test("only a single-player game that asked gets a logger", () => {
    configureDevNationTimingLog(GameType.Singleplayer, true, () => {});
    expect(devNationTimingLogger()).toBeDefined();
    for (const [type, on] of [
      [GameType.Public, true],
      [GameType.Private, true],
      [GameType.Singleplayer, false],
      [GameType.Singleplayer, undefined],
    ] as const) {
      configureDevNationTimingLog(GameType.Singleplayer, true, () => {});
      configureDevNationTimingLog(type, on, () => {});
      expect(devNationTimingLogger()).toBeUndefined();
    }
  });

  test("the stats mode is a logger too", () => {
    configureDevNationTimingLog(GameType.Singleplayer, "stats", () => {});
    expect(devNationTimingLogger()).toBeDefined();
    configureDevNationTimingLog(GameType.Public, "stats", () => {});
    expect(devNationTimingLogger()).toBeUndefined();
  });

  test("the start line: timing, spread, difficulty, base interval R (min, max, mean) and the nation count", async () => {
    const game = await setup(
      "world",
      {},
      [],
      undefined,
      undefined,
      false,
      loadWorldNations(6),
    );
    const lines: string[] = [];
    configureDevNationTimingLog(GameType.Singleplayer, true, (l) =>
      lines.push(l),
    );
    // R is only known once a nation is initialised: nothing before that.
    const build = () => {
      const execs = new Executor(
        game,
        "log-start",
        undefined,
      ).nationExecutions();
      const before = lines.length;
      for (const e of execs) e.init(game, 0);
      return { execs, printedByInit: lines.length - before };
    };
    const rOf = (e: unknown) => (e as { attackRate: number }).attackRate;
    const rText = (execs: unknown[]) => {
      const r = execs.map(rOf);
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      return `最小=${Math.min(...r)} 最大=${Math.max(...r)} 平均=${mean.toFixed(1)}`;
    };
    const difficulty = String(game.config().gameConfig().difficulty);

    const first = build();
    setDevNationTiming({ spread: 0.5 });
    const second = build();
    expect(first.printedByInit).toBe(1);
    expect(second.printedByInit).toBe(1);
    expect(lines).toEqual([
      `[NationTiming] 開始 nationTiming=未生效(舊格點) 參數來源=無 難度=${difficulty} 基準間隔R ${rText(first.execs)} 國家數=6`,
      `[NationTiming] 開始 nationTiming=生效 spread=0.50 參數來源=載入時網址 難度=${difficulty} 基準間隔R ${rText(second.execs)} 國家數=6`,
    ]);
  });

  test("a nation that never reports its R does not hold the start line back", () => {
    const lines: string[] = [];
    const logger = new NationTimingLogger((l) => lines.push(l), true, {
      difficulty: "Hard",
      aliveNations: () => 2,
    });
    logger.start(undefined, 3);
    logger.nationReady(40);
    logger.nationReady(50);
    expect(lines).toEqual([]);
    logger.wake(10, "a");
    expect(lines).toEqual([
      "[NationTiming] 開始 nationTiming=未生效(舊格點) 參數來源=無 難度=Hard 基準間隔R 最小=40 最大=50 平均=45.0 國家數=3",
    ]);
  });

  test("worldOf counts only the living nations (players() is the living ones)", () => {
    const player = (type: PlayerType) => ({ type: () => type });
    const game = {
      config: () => ({ gameConfig: () => ({ difficulty: Difficulty.Medium }) }),
      players: () => [
        player(PlayerType.Nation),
        player(PlayerType.Human),
        player(PlayerType.Nation),
        player(PlayerType.Bot),
      ],
    } as unknown as Game;
    const world = worldOf(game);
    expect(world.difficulty).toBe("Medium");
    expect(world.aliveNations()).toBe(2);
  });
});

describe("nation timing log: lines and statistics", () => {
  const list: Array<() => boolean> = [() => true];

  function policyLog() {
    const lines: string[] = [];
    const logger = new NationTimingLogger((l) => lines.push(l));
    let tick = 0;
    const calls: string[] = [];
    const inner: AttackPolicy = {
      beginTurn: () => calls.push("begin"),
      attackSent: () => calls.push("sent"),
      endTurn: () => calls.push("end"),
      engage: (ctx) => (ctx.hasReserve && ctx.hasTrigger ? "attack" : "hold"),
      strengthStrategies: () => list,
    };
    const policy = logger.wrap(
      inner,
      { ticks: () => tick } as Game,
      "n1",
      "法國",
    );
    const turn = (
      t: number,
      ctx: Partial<EngageContext> | null,
      sent: boolean,
    ) => {
      tick = t;
      policy.beginTurn?.({ reserveRatio: 0.3, triggerRatio: 0.5 });
      if (ctx !== null) policy.engage(ctx as EngageContext);
      if (sent) policy.attackSent?.({} as never, 10, "land");
      policy.endTurn?.();
    };
    return { lines, calls, turn, policy };
  }

  test("each wake logs its gap and outcome, and the real policy sees every call", () => {
    const { lines, calls, turn } = policyLog();
    turn(100, { hasReserve: false, hasTrigger: false }, false); // below the reserve
    turn(152, { hasReserve: true, hasTrigger: false }, false); // draw failed
    turn(203, { hasReserve: true, hasTrigger: true }, false); // no target
    turn(260, { hasReserve: true, hasTrigger: true }, true); // attacked
    turn(300, null, false); // never reached the decision
    expect(lines).toEqual([
      "[NationTiming] t=100 法國 間隔=首次 結果=門檻沒過",
      "[NationTiming] t=152 法國 間隔=52刻 結果=抽籤沒過",
      "[NationTiming] t=203 法國 間隔=51刻 結果=沒有目標",
      "[NationTiming] t=260 法國 間隔=57刻 結果=發動攻擊",
      "[NationTiming] t=300 法國 間隔=40刻 結果=未進入判斷",
    ]);
    expect(calls.filter((c) => c === "begin")).toHaveLength(5);
    expect(calls.filter((c) => c === "end")).toHaveLength(5);
    expect(calls.filter((c) => c === "sent")).toHaveLength(1);
  });

  test("the strength strategies are the real policy's own list", () => {
    const { policy } = policyLog();
    expect(policy.strengthStrategies({} as never)).toBe(list);
  });

  test("every 3000 ticks a statistics line: gap mean, sd, min, max, simultaneous wakes", () => {
    const lines: string[] = [];
    const logger = new NationTimingLogger((l) => lines.push(l), true, {
      difficulty: "Hard",
      aliveNations: () => 7,
    });
    // nation a wakes at 0, 50, 110 (gaps 50, 60); nation b at 0, 70 (gap 70);
    // at tick 0 two nations woke together, at 50, 70 and 110 one each
    logger.wake(0, "a");
    logger.wake(0, "b");
    logger.wake(50, "a");
    logger.wake(70, "b");
    logger.wake(110, "a");
    expect(lines).toEqual([]);
    logger.wake(3000, "a"); // crosses the boundary: report first
    expect(lines).toEqual([
      "[NationTiming] 統計 t<3000(自上次統計起) 存活國家=7 醒來國家數=2 醒來間隔 n=3 平均=60.0 標準差=8.2 最小=50 最大=70 | 同刻醒來 最大=2 平均=1.25(只計有國家醒來的刻)",
    ]);
  });

  test("alive nations are read when the line is printed; the woke count is per window", () => {
    const lines: string[] = [];
    let alive = 5;
    const logger = new NationTimingLogger((l) => lines.push(l), true, {
      difficulty: "Hard",
      aliveNations: () => alive,
    });
    logger.wake(0, "a");
    logger.wake(0, "b");
    logger.wake(100, "c"); // three distinct nations in the first window
    alive = 4; // one died before the first line was printed
    logger.wake(3000, "a"); // first line: reads 4, counts a, b, c
    alive = 2;
    logger.wake(3100, "a");
    logger.wake(6000, "a"); // second line: reads 2, only a woke in 3000..5999
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("存活國家=4 醒來國家數=3 ");
    expect(lines[1]).toContain("存活國家=2 醒來國家數=1 ");
  });
});
