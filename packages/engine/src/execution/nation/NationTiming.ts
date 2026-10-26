import { GameType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zNum,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import type {
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";

/**
 * When a nation thinks, if not on the old fixed lattice (tick % attackRate ==
 * attackTick). Phase A: the gaps between thinks are jittered, nothing else.
 */
export interface NationTimingConfig {
  /**
   * A per-nation trait, not a global setting: like triggerRatio and
   * reserveRatio it belongs to the one nation, is kept in that nation's
   * snapshot state and may differ between nations of the same game (the mixed
   * games of the evidence runs do exactly that).
   *
   * Half-width of the jitter as a fraction of the nation's attackRate, 0 <= s
   * < 1. Gaps are triangular on [(1 - s) R, (1 + s) R] with mean R, so the
   * long-run think frequency is the old one. 0 is the old metronome exactly.
   */
  spread: number;
}

/** Added to the nation's own seed, so this stream is never the shared one. */
const TIMING_SALT = 0x5bd1e995;
/** Gap draws are on this integer grid: no transcendental math, same bits everywhere. */
const GRID = 1024;

export class NationTiming {
  /** The tick of the next think; null until the first tick the gate is asked. */
  private nextSlot: number | null = null;

  constructor(
    readonly spread: number,
    private rng: PseudoRandom,
  ) {
    if (!(spread >= 0 && spread < 1)) {
      throw new Error(`nation timing spread must be in [0, 1): ${spread}`);
    }
  }

  /** seed: the nation's own seed (id and game); the salt is added here. */
  static create(config: NationTimingConfig, seed: number): NationTiming {
    return new NationTiming(
      config.spread,
      new PseudoRandom(seed + TIMING_SALT),
    );
  }

  /**
   * Whether the nation thinks at `ticks`. Called once per tick once the nation
   * is running. The first think is on the old lattice (so the early game keeps
   * its pace); the gap after each think is drawn from the timing stream.
   * Slots missed (a tick nobody asked about) are dropped, as the lattice does.
   */
  shouldThink(ticks: number, rate: number, attackTick: number): boolean {
    this.nextSlot ??= ticks + ((attackTick - (ticks % rate) + rate) % rate);
    while (this.nextSlot < ticks) this.nextSlot += this.gap(rate);
    if (this.nextSlot !== ticks) return false;
    this.nextSlot += this.gap(rate);
    return true;
  }

  /** A gap: rate * (1 + s * (a + b - 1)), a and b uniform, rounded without bias. */
  private gap(rate: number): number {
    const a = this.rng.nextInt(0, GRID);
    const b = this.rng.nextInt(0, GRID);
    const c = this.rng.nextInt(0, GRID);
    // (a + b + 1) / GRID has mean exactly 1: the gap has mean exactly rate
    const x = rate * (1 + this.spread * ((a + b + 1) / GRID - 1));
    const whole = Math.floor(x);
    return Math.max(1, whole + ((c + 0.5) / GRID < x - whole ? 1 : 0));
  }

  snapshot(w: SnapshotWriter): TimingState {
    return {
      spread: this.spread,
      nextSlot: this.nextSlot,
      rng: w.random(this.rng),
    };
  }

  static restore(s: TimingState, r: SnapshotReader): NationTiming {
    const timing = new NationTiming(s.spread, r.random(s.rng));
    timing.nextSlot = s.nextSlot;
    return timing;
  }
}

export const TimingStateSchema = z.object({
  spread: zNum(),
  nextSlot: zInt().nullable(),
  rng: zRandom(),
});
export type TimingState = z.infer<typeof TimingStateSchema>;

// Development switch: nations created by the game (ExecutionManager) use this
// timing when it is set. Never set in a real game; every client of one game
// must agree on it, so it is for local, single-player experiments only.
let devTiming: NationTimingConfig | undefined;

export function setDevNationTiming(config: NationTimingConfig | undefined) {
  devTiming = config;
}

/**
 * What the worker does with the page's request (`?nationTiming=` in dev):
 * only a single-player game takes it, and only a valid spread. Anything else
 * clears the switch, so a worker never keeps a value from an earlier game and
 * a multiplayer room (lockstep: every client must run the same thing) ignores
 * the request entirely.
 */
export function configureDevNationTiming(
  gameType: GameType,
  spread: number | undefined,
): void {
  const valid =
    spread !== undefined &&
    Number.isFinite(spread) &&
    spread >= 0 &&
    spread < 1;
  setDevNationTiming(
    gameType === GameType.Singleplayer && valid ? { spread } : undefined,
  );
}

export function devNationTiming(): NationTimingConfig | undefined {
  return devTiming;
}
