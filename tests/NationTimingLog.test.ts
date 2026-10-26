// Behaviour pinned: the dev diagnostic log of nation wake-ups ([NationTiming]).
// - turning it on changes nothing: the hash chain of the same game is the same
//   with the log on and off, on the old lattice and with jittered timing
// - it is on only for a single-player game that asked; otherwise no logger
// - one line per wake (tick, name, gap since the last wake, outcome), a start
//   line, and a statistics line every 3000 ticks with the right numbers
// - the decorator passes every call to the real policy unchanged
// The page side is in tests/client/DevNationTiming.test.ts.
import { Difficulty, GameType } from "@openfront/engine-api/game/GameTypes";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { setDevNationTiming } from "@openfront/engine/execution/nation/NationTiming";
import {
  configureDevNationTimingLog,
  devNationTimingLogger,
  NationTimingLogger,
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
): Promise<string> {
  if (log === null) {
    configureDevNationTimingLog(GameType.Singleplayer, false);
  } else {
    configureDevNationTimingLog(GameType.Singleplayer, true, (l) =>
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
    },
    300_000,
  );
});

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

  test("the start line says whether the timing is on, its spread and the nation count", async () => {
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
    new Executor(game, "log-start", undefined).nationExecutions();
    setDevNationTiming({ spread: 0.5 });
    new Executor(game, "log-start", undefined).nationExecutions();
    expect(lines).toEqual([
      "[NationTiming] 開始 nationTiming=未生效(舊格點) 國家數=6",
      "[NationTiming] 開始 nationTiming=生效 spread=0.50 國家數=6",
    ]);
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
    const logger = new NationTimingLogger((l) => lines.push(l));
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
      "[NationTiming] 統計 t<3000(自上次統計起) 醒來間隔 n=3 平均=60.0 標準差=8.2 最小=50 最大=70 | 同刻醒來 最大=2 平均=1.25(只計有國家醒來的刻)",
    ]);
  });
});
