// Human Trace: a dev-only recording of how a person plays a single-player
// game (inputs, the intents they produce, the camera) plus the turn stream,
// for watching and analysing play. It only reads. Nothing here feeds back
// into the game: no extra queries, no intent of its own, no change to what
// the local server accepts. Every public method swallows its own failures, so
// a broken recorder can never reach the game.

export const TRACE_VERSION = 1;
const FLUSH_MS = 2000;
const MAX_BUFFERED_LINES = 4000;
const MAX_BUFFERED_TURNS = 4000;
const CAMERA_MIN_GAP_MS = 250; // at most 4 Hz

/** Where batches go. Resolves true when the batch was stored. */
export interface TraceSink {
  traceLines(gameID: string, lines: string[]): Promise<boolean>;
  recordTurns(
    gameID: string,
    header: object | null,
    turns: object[],
  ): Promise<boolean>;
}

/** Used when the sink fails; same shape, keeps the batch in the browser. */
export interface FallbackStore {
  store(
    gameID: string,
    kind: "trace" | "record",
    payload: unknown,
  ): Promise<void>;
}

/** Plain reads of the running game, supplied by the page. */
export interface TraceContext {
  tick(): number | undefined;
  summary(): Record<string, unknown> | undefined;
  camera(): { scale: number; x: number; y: number } | undefined;
}

export interface TraceHeaderInfo {
  gameID: string;
  commit: string;
  mode: "singleplayer";
  map: string;
  difficulty: string;
  nations: string | number;
  bots: number | undefined;
  /** The engine seeds from the game id; there is no separate seed field. */
  seed: string;
  players: unknown[];
  urlParams: string;
  turnIntervalMs: number;
  moves: boolean;
  screen: { w: number; h: number; dpr: number };
}

export type IntentOutcome = "sent" | "dropped_paused";

export interface TraceOptions {
  now: () => number; // performance.now
  wallNow: () => number; // Date.now
  sink: TraceSink;
  fallback?: FallbackStore;
  moves: boolean;
  flushMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class HumanTrace {
  private t0: number;
  private lines: string[] = [];
  private turns: object[] = [];
  private recordHeader: object | null = null;
  private recordHeaderSent = false;
  private timer: unknown;
  private flushing: Promise<void> = Promise.resolve();
  private ctx: TraceContext | undefined;
  private lastCamera = -Infinity;
  private lastCameraKey = "";
  private ended = false;
  private droppedLines = 0;
  private droppedTurns = 0;
  private gameID = "";

  constructor(private opts: TraceOptions) {
    this.t0 = opts.now();
  }

  get movesEnabled(): boolean {
    return this.opts.moves;
  }

  setContext(ctx: TraceContext | undefined): void {
    this.ctx = ctx;
  }

  /** Milliseconds since the trace started (performance.now based). */
  private tMs(): number {
    return Math.round((this.opts.now() - this.t0) * 100) / 100;
  }

  start(info: TraceHeaderInfo, startInfo?: unknown): void {
    this.safe(() => {
      this.gameID = info.gameID;
      this.t0 = this.opts.now();
      const startedAtWall = this.opts.wallNow();
      this.push({
        k: "header",
        version: TRACE_VERSION,
        ...info,
        startedAtWall,
        tickBase: {
          turnIntervalMs: info.turnIntervalMs,
          note: "one turn = one tick; tMs is performance.now since start",
        },
      });
      this.recordHeader = {
        version: TRACE_VERSION,
        gameID: info.gameID,
        commit: info.commit,
        map: info.map,
        difficulty: info.difficulty,
        nations: info.nations,
        bots: info.bots,
        seed: info.seed,
        players: info.players,
        urlParams: info.urlParams,
        turnIntervalMs: info.turnIntervalMs,
        startedAtWall,
        gameStartInfo: startInfo,
      };
      const set = this.opts.setTimer ?? ((f, ms) => setInterval(f, ms));
      this.timer = set(() => void this.flush(), this.opts.flushMs ?? FLUSH_MS);
    });
  }

  input(ev: Record<string, unknown>): void {
    this.safe(() => {
      this.push({
        k: "input",
        tMs: this.tMs(),
        tick: this.ctx?.tick(),
        ...ev,
      });
    });
  }

  intent(
    intent: Record<string, unknown>,
    serverTick: number,
    outcome: IntentOutcome,
  ): void {
    this.safe(() => {
      this.push({
        k: "intent",
        tMs: this.tMs(),
        tick: this.ctx?.tick(),
        serverTick,
        type: intent.type,
        params: intent,
        outcome,
        reason: outcome === "dropped_paused" ? "paused" : undefined,
        state: this.ctx?.summary(),
      });
    });
  }

  /** A turn reached the client. Goes to the record at the next flush. */
  turn(turn: { turnNumber: number; intents: unknown[] }): void {
    this.safe(() => {
      const arrivalMs = this.tMs();
      if (this.turns.length >= MAX_BUFFERED_TURNS) {
        this.turns.shift();
        this.droppedTurns++;
      }
      this.turns.push({
        turnNumber: turn.turnNumber,
        intents: turn.intents,
        arrivalMs,
      });
      if (turn.intents.length > 0) {
        this.push({
          k: "turn",
          tMs: arrivalMs,
          turnNumber: turn.turnNumber,
          n: turn.intents.length,
          types: turn.intents.map((i) => (i as { type?: string }).type),
        });
      }
      // A sample of how game ticks relate to turns and real time.
      if (turn.turnNumber % 50 === 0) {
        this.push({
          k: "sync",
          tMs: arrivalMs,
          turnNumber: turn.turnNumber,
          tick: this.ctx?.tick(),
        });
      }
    });
  }

  camera(): void {
    this.safe(() => {
      const now = this.opts.now();
      if (now - this.lastCamera < CAMERA_MIN_GAP_MS) return;
      const cam = this.ctx?.camera();
      if (cam === undefined) return;
      const key = `${cam.scale.toFixed(3)}|${cam.x.toFixed(1)}|${cam.y.toFixed(1)}`;
      if (key === this.lastCameraKey) return;
      this.lastCamera = now;
      this.lastCameraKey = key;
      this.push({
        k: "camera",
        tMs: this.tMs(),
        tick: this.ctx?.tick(),
        ...cam,
      });
    });
  }

  event(name: string, extra: Record<string, unknown> = {}): void {
    this.safe(() => this.push({ k: name, tMs: this.tMs(), ...extra }));
  }

  /** Stop the timer and send everything that is left. */
  end(): Promise<void> {
    if (this.ended) return this.flushing;
    this.ended = true;
    this.safe(() => {
      if (this.timer !== undefined) {
        (this.opts.clearTimer ?? ((id) => clearInterval(id as never)))(
          this.timer,
        );
      }
      this.push({ k: "end", tMs: this.tMs() });
    });
    return this.flush();
  }

  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushOnce()).catch(() => {});
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    if (this.gameID === "") return;
    const lines = this.lines;
    const turns = this.turns;
    this.lines = [];
    this.turns = [];
    if (lines.length > 0) {
      await this.deliver("trace", lines, () =>
        this.opts.sink.traceLines(this.gameID, lines),
      );
    }
    if (turns.length > 0) {
      const header = this.recordHeaderSent ? null : this.recordHeader;
      const ok = await this.deliver("record", { header, turns }, () =>
        this.opts.sink.recordTurns(this.gameID, header, turns),
      );
      if (ok && header !== null) this.recordHeaderSent = true;
    }
  }

  private async deliver(
    kind: "trace" | "record",
    payload: unknown,
    send: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      if (await send()) return true;
    } catch {
      // treated like a refusal: the batch goes to the browser store
    }
    try {
      await this.opts.fallback?.store(this.gameID, kind, payload);
    } catch {
      // Neither the server nor the browser store took it: the batch is lost,
      // the game goes on.
      if (kind === "trace") this.droppedLines += (payload as unknown[]).length;
    }
    return false;
  }

  private push(obj: Record<string, unknown>): void {
    if (this.lines.length >= MAX_BUFFERED_LINES) {
      this.lines.shift();
      this.droppedLines++;
    }
    this.lines.push(JSON.stringify(obj));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Recording must never disturb the game.
    }
  }

  /** What is waiting to be sent, and what was lost to the memory cap. */
  pending(): {
    lines: number;
    turns: number;
    droppedLines: number;
    droppedTurns: number;
  } {
    return {
      lines: this.lines.length,
      turns: this.turns.length,
      droppedLines: this.droppedLines,
      droppedTurns: this.droppedTurns,
    };
  }
}

// The one active trace of the page, set while a recorded game runs.
let active: HumanTrace | undefined;

export function activeHumanTrace(): HumanTrace | undefined {
  return active;
}

export function setActiveHumanTrace(t: HumanTrace | undefined): void {
  active = t;
}
