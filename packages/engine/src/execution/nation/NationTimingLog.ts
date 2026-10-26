import { GameType } from "@openfront/engine-api/game/GameTypes";
import type { TerraNullius } from "@openfront/engine-api/game/GameTypes";
import type { Game, Player } from "../../game/Game";
import type {
  AttackPolicy,
  EngageContext,
  EngageDecision,
  StrengthContext,
  TurnInfo,
} from "../utils/AttackPolicy";

// Dev-only diagnostic log of when nations wake up and what they decide
// (page URL `&nationTimingLog=1`, single-player only). It only reads: the
// decorator below hands every call to the real policy unchanged and looks at
// plain values (the tick, the booleans of the engage context, the decision);
// it never queries the game beyond `ticks()`, never draws from a PRNG and
// never touches the boat-route cache.

const PREFIX = "[NationTiming]";
const REPORT_EVERY = 3000;

export type LogSink = (line: string) => void;

export type WakeOutcome =
  | "發動攻擊"
  | "門檻沒過"
  | "抽籤沒過"
  | "沒有目標"
  | "未進入判斷";

interface Stats {
  n: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
  /** Ticks in which at least one nation woke, and the wakes in them. */
  busyTicks: number;
  wakes: number;
  maxSimultaneous: number;
}

const emptyStats = (): Stats => ({
  n: 0,
  sum: 0,
  sumSq: 0,
  min: Infinity,
  max: -Infinity,
  busyTicks: 0,
  wakes: 0,
  maxSimultaneous: 0,
});

export class NationTimingLogger {
  private lastWake = new Map<string, number>();
  private win = emptyStats();
  private curTick = -1;
  private curCount = 0;
  private nextReport = REPORT_EVERY;

  constructor(private sink: LogSink) {}

  start(spread: number | undefined, nations: number): void {
    const timing =
      spread === undefined
        ? "未生效(舊格點)"
        : `生效 spread=${spread.toFixed(2)}`;
    this.sink(`${PREFIX} 開始 nationTiming=${timing} 國家數=${nations}`);
  }

  /** A nation wakes into its attack decision. Returns the gap since its last wake. */
  wake(tick: number, id: string): number | null {
    if (tick !== this.curTick) this.closeTick();
    // The wake that crosses the boundary belongs to the next window.
    if (tick >= this.nextReport) {
      this.report(this.nextReport);
      while (tick >= this.nextReport) this.nextReport += REPORT_EVERY;
    }
    this.curTick = tick;
    this.curCount++;
    const last = this.lastWake.get(id);
    this.lastWake.set(id, tick);
    if (last === undefined) return null;
    const gap = tick - last;
    const w = this.win;
    w.n++;
    w.sum += gap;
    w.sumSq += gap * gap;
    w.min = Math.min(w.min, gap);
    w.max = Math.max(w.max, gap);
    return gap;
  }

  line(tick: number, name: string, gap: number | null, outcome: WakeOutcome) {
    const g = gap === null ? "首次" : `${gap}刻`;
    this.sink(`${PREFIX} t=${tick} ${name} 間隔=${g} 結果=${outcome}`);
  }

  wrap(
    inner: AttackPolicy,
    game: Game,
    id: string,
    name: string,
  ): AttackPolicy {
    return new LoggedAttackPolicy(inner, this, game, id, name);
  }

  private closeTick(): void {
    if (this.curCount === 0) return;
    const w = this.win;
    w.busyTicks++;
    w.wakes += this.curCount;
    w.maxSimultaneous = Math.max(w.maxSimultaneous, this.curCount);
    this.curCount = 0;
  }

  private report(boundary: number): void {
    this.closeTick();
    const w = this.win;
    const mean = w.n === 0 ? 0 : w.sum / w.n;
    const sd =
      w.n === 0 ? 0 : Math.sqrt(Math.max(0, w.sumSq / w.n - mean * mean));
    const sim = w.busyTicks === 0 ? 0 : w.wakes / w.busyTicks;
    this.sink(
      `${PREFIX} 統計 t<${boundary}(自上次統計起) 醒來間隔 n=${w.n} ` +
        `平均=${mean.toFixed(1)} 標準差=${sd.toFixed(1)} ` +
        `最小=${w.n === 0 ? "-" : w.min} 最大=${w.n === 0 ? "-" : w.max} | ` +
        `同刻醒來 最大=${w.maxSimultaneous} 平均=${sim.toFixed(2)}(只計有國家醒來的刻)`,
    );
    this.win = emptyStats();
  }
}

/**
 * Passes every call to the real policy and records what it saw. The strength
 * strategies are the inner policy's own list, not wrapped.
 */
class LoggedAttackPolicy implements AttackPolicy {
  private gap: number | null = null;
  private hasReserve = true;
  private decision: EngageDecision | null = null;
  private sent = false;

  constructor(
    private inner: AttackPolicy,
    private logger: NationTimingLogger,
    private game: Game,
    private id: string,
    private name: string,
  ) {}

  beginTurn(info: TurnInfo): void {
    this.gap = this.logger.wake(this.game.ticks(), this.id);
    this.hasReserve = true;
    this.decision = null;
    this.sent = false;
    this.inner.beginTurn?.(info);
  }

  engage(ctx: EngageContext): EngageDecision {
    this.hasReserve = ctx.hasReserve;
    this.decision = this.inner.engage(ctx);
    return this.decision;
  }

  strengthStrategies(ctx: StrengthContext): Array<() => boolean> {
    return this.inner.strengthStrategies(ctx);
  }

  attackSent(
    target: Player | TerraNullius,
    troops: number,
    kind: "land" | "boat",
  ): void {
    this.sent = true;
    this.inner.attackSent?.(target, troops, kind);
  }

  endTurn(): void {
    this.inner.endTurn?.();
    this.logger.line(this.game.ticks(), this.name, this.gap, this.outcome());
  }

  private outcome(): WakeOutcome {
    if (this.sent) return "發動攻擊";
    if (this.decision === "hold") {
      return this.hasReserve ? "抽籤沒過" : "門檻沒過";
    }
    if (this.decision === "attack") return "沒有目標";
    return "未進入判斷";
  }
}

// The switch, set by the worker per game (like NationTiming's dev switch).
let active: NationTimingLogger | undefined;

export function devNationTimingLogger(): NationTimingLogger | undefined {
  return active;
}

const consoleSink: LogSink = (line) => console.info(line);

/**
 * Only a single-player game that asked for it gets a logger; anything else
 * clears it, so nothing outlives its game and a multiplayer room does nothing.
 */
export function configureDevNationTimingLog(
  gameType: GameType,
  enabled: boolean | undefined,
  sink: LogSink = consoleSink,
): void {
  active =
    gameType === GameType.Singleplayer && enabled === true
      ? new NationTimingLogger(sink)
      : undefined;
}
