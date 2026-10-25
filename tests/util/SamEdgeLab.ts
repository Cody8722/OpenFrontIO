import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  BOMB_INDEX_INTERCEPT,
  unitTypeToBombUnit,
} from "@openfront/engine-api/StatsSchemas";
import { MirvExecution } from "@openfront/engine/execution/MIRVExecution";
import { MissileSiloExecution } from "@openfront/engine/execution/MissileSiloExecution";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { SAMLauncherExecution } from "@openfront/engine/execution/SAMLauncherExecution";
import { Execution, Game, Player, Unit } from "@openfront/engine/game/Game";
import type {
  ExecRecord,
  SnapshotWriter,
} from "@openfront/engine/snapshot/SnapshotContext";
import { SamLabConfig } from "./SamLab";
import { setup } from "./Setup";

export const SILO = { x: 5, y: 100 };
export const TARGET = { x: 60, y: 100 };
export const SAM_LEVEL = 50;
// The spec asks for >100 ticks after the upgrade before measuring.
const WARMUP_TICKS = 120;
const BOMB_KEYS = [
  unitTypeToBombUnit[UnitType.AtomBomb],
  unitTypeToBombUnit[UnitType.HydrogenBomb],
  unitTypeToBombUnit[UnitType.MIRVWarhead],
];

export type Order = "samFirst" | "nukeFirst";
export interface Placement {
  x: number;
  y: number;
  /** SAM level (default SAM_LEVEL). */
  level?: number;
  /** 0 = defender, 1 = defender2 (needs `secondDefender`). */
  owner?: 0 | 1;
}
export type Fate = "PENDING" | "INTERCEPTED" | "LANDED";
export type EdgeClass =
  | "INTERCEPTED"
  | "LEAK_INFEASIBLE"
  | "BUG_FEASIBLE_NO_SHOT"
  | "BUG_LOCKED_BUT_LANDED"
  | "PENDING";

export interface LockEvent {
  tick: number;
  sam: number;
  /** cached.tick this SAM held for the nuke before firing (null: none). */
  cachedBefore: number | null;
  samLevel: number;
  /** dynamicSamRange of the firing SAM at the firing tick. */
  rangeNow: number;
  /** The nuke's trajectory index / remaining wait when the SAM fired. */
  nukeIdx: number;
  nukeWait: number;
  trajTiles: number[];
  /** The tile the SAM missile flies to (null until read from its execution). */
  tile: number | null;
  /** Distance from the SAM to that tile. */
  tileDist: number | null;
  /** dynamicSamRange when the nuke would reach that tile (what the engine checks). */
  rangeAtArrival: number | null;
  /** Tile is out of range at arrival AND the detonation tile is out of range too. */
  overRange: boolean;
}

export interface FlagChange {
  tick: number;
  value: boolean;
}

export interface EdgeRecord {
  id: number;
  kind: "atom" | "hydrogen" | "warhead";
  spawnTick: number;
  waitTicks: number;
  trajLen: number;
  feasibleAtSpawn: number[];
  feasibleEver: boolean;
  firstFeasibleTick: number;
  lastFeasibleTick: number;
  /** Distinct cached.tick values seen per SAM, in order of appearance. */
  cached: number[][];
  locks: LockEvent[];
  missileFirstSeen: number;
  missileGone: number;
  /** Distance from the firing SAM to where its missile was last seen. */
  missileLastDist: number | null;
  /** Where that missile was last seen (a tile ref), i.e. the kill site. */
  missileLastTile: number | null;
  fate: Fate;
  fateTick: number;
  flagTrace: FlagChange[];
  /** Consecutive observed ticks with the flag set but no live SAM missile. */
  residualStreak: number;
  maxResidualStreak: number;
  /** A live SAM could still have intercepted after the flag was cleared. */
  feasibleAfterClear: boolean;
  /** Ready magazine slots among the feasible SAMs at the last feasible tick. */
  readyAtLastFeasible: number;
}

type CacheEntry = { id: number; tick: number; tile: number };
type TargetingProbe = { targetingSystem?: { getState(): CacheEntry[] } };
type BombStats = { bombs?: Record<string, bigint[]> };
type CacheView = Map<number, { tick: number; tile: number }>;
type Pre = { locked: Set<number>; cache: CacheView };
export type HookPos = "pre" | `after${number}`;
interface Hook {
  relTick: number;
  pos: HookPos;
  label: string;
  fn: () => void;
  done: boolean;
  /** Changes what a SAM sees at its next look (e.g. a level change). */
  affectsLook: boolean;
}

export function edgeClass(r: EdgeRecord): EdgeClass {
  if (r.fate === "INTERCEPTED") return "INTERCEPTED";
  if (r.fate === "PENDING") return "PENDING";
  if (r.locks.length > 0) return "BUG_LOCKED_BUT_LANDED";
  return r.feasibleEver ? "BUG_FEASIBLE_NO_SHOT" : "LEAK_INFEASIBLE";
}

/** SAMLauncherExecution that reports each tick to the lab, and can be paused. */
class LoggedSamExec extends SAMLauncherExecution {
  paused = false;
  constructor(
    player: Player,
    sam: Unit,
    private readonly idx: number,
    private readonly lab: EdgeLab,
  ) {
    super(player, null, sam);
  }
  tick(ticks: number): void {
    if (this.paused) return;
    const pre = this.lab.samBefore(this.cacheOf());
    super.tick(ticks);
    this.lab.samAfter(this.idx, ticks, pre, this.cacheOf());
  }
  private cacheOf(): CacheView {
    const sys = (this as unknown as TargetingProbe).targetingSystem;
    return new Map(
      (sys?.getState() ?? []).map((e) => [
        e.id,
        { tick: e.tick, tile: e.tile },
      ]),
    );
  }
}

/** Runs the lab's scheduled actions at one position in the tick order. */
class HookExec implements Execution {
  constructor(
    private readonly lab: EdgeLab,
    private readonly pos: HookPos,
  ) {}
  init(): void {}
  tick(ticks: number): void {
    this.lab.runHooks(ticks, this.pos);
  }
  isActive(): boolean {
    return true;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }
  snapshot(_w: SnapshotWriter): ExecRecord {
    throw new Error("HookExec is a test helper and cannot be snapshotted");
  }
}

/**
 * Oracle: could a SAM fired now still meet this nuke? Same geometry as
 * SAMTargetingSystem.computeInterceptionTile, minus its "stop scanning after
 * the distance keeps growing" shortcut, plus the detonation-tile branch.
 * `advance` models a nuke whose execution runs before the SAM's: the SAM's next
 * look is then at the state after the nuke's next step.
 */
export function samFeasible(
  g: Game,
  nuke: Unit,
  sam: Unit,
  t: number,
  advance: boolean,
): boolean {
  if (!sam.isActive()) return false;
  const cfg = g.config();
  const traj = nuke.trajectory();
  if (traj.length < 2) return false;
  let cur = nuke.trajectoryIndex();
  let wait = nuke.nukeState().waitTicks ?? 0;
  if (advance) {
    if (wait > 0) wait--;
    else cur++;
  }
  const speed = cfg.defaultSamMissileSpeed();
  const maxIdx = traj.length - 2;
  for (let i = cur; i <= maxIdx; i++) {
    const tile = traj[i];
    const nukeTicks = i - cur + wait;
    const samTicks = Math.ceil(g.manhattanDist(sam.tile(), tile.tile) / speed);
    const allowed = cfg.dynamicSamRange(sam, t + nukeTicks);
    if (
      tile.targetable &&
      g.euclideanDistSquared(sam.tile(), tile.tile) <= allowed * allowed &&
      nukeTicks >= samTicks
    ) {
      return true;
    }
  }
  const finalTile = traj[traj.length - 1];
  const flight = traj[maxIdx];
  if (!finalTile.targetable || !flight.targetable) return false;
  const expTicks = traj.length - 1 - cur + wait;
  const range = cfg.dynamicSamRange(sam, t + expTicks);
  if (g.euclideanDistSquared(sam.tile(), finalTile.tile) > range * range) {
    return false;
  }
  const nukeTicks = maxIdx - cur + wait;
  return (
    nukeTicks >= Math.ceil(g.manhattanDist(sam.tile(), flight.tile) / speed)
  );
}

export class EdgeLab {
  readonly records = new Map<number, EdgeRecord>();
  readonly lines: string[] = [];
  readonly t0: number;
  mirvWarheadCount = 0;

  private samExecs: LoggedSamExec[];
  private prevAlive = new Set<number>();
  private missiles = new Map<
    number,
    { target: number; seen: number; lastTile: number }
  >();
  private prevIntercept = 0;
  private mirv: MirvExecution | null = null;
  private reordered = false;
  private hooks: Hook[] = [];
  private prevFlag = new Map<number, boolean>();
  private unitsById = new Map<number, Unit>();

  private constructor(
    readonly game: Game,
    readonly attacker: Player,
    readonly defender: Player,
    readonly sams: Unit[],
    readonly owners: Player[],
    readonly order: Order,
    private readonly verbose: boolean,
    siloLevel: number,
  ) {
    // Hook execs sit before the SAM execs ("pre") and after each one, so a
    // scheduled action lands at an exact spot in the tick order.
    game.addExecution(new HookExec(this, "pre"));
    this.samExecs = sams.map((s, i) => {
      const exec = this.addSamExec(s, i);
      game.addExecution(new HookExec(this, `after${i}`));
      return exec;
    });
    // MissileSiloExecution reloads one slot per tick, so a level-L silo needs
    // L-1 extra ticks. Level 1 adds none, keeping older runs' absolute ticks
    // (and so the MIRV seeds derived from them) unchanged.
    const warmup = WARMUP_TICKS + Math.max(0, siloLevel - 1);
    for (let i = 0; i < warmup; i++) game.executeNextTick();
    const ready = sams.map((s) => s.level() - s.missileTimerQueue().length);
    if (ready.some((r, i) => r !== sams[i].level())) {
      this.lines.push(`[警告] 暖機後 SAM 未全部裝填 ready=[${ready}]`);
    }
    this.t0 = game.ticks();
    this.prevIntercept = this.readInterceptCount();
  }

  static async create(opts: {
    sams: Placement[];
    order: Order;
    wide?: boolean;
    verbose?: boolean;
    siloLevel?: number;
    /** Adds a PlayerExecution per defender, as in a real game. */
    playerExecs?: boolean;
  }): Promise<EdgeLab> {
    const needSecond = opts.sams.some((p) => p.owner === 1);
    const game = await setup(
      "big_plains",
      { infiniteGold: true, instantBuild: true },
      [
        new PlayerInfo("attacker", PlayerType.Human, "c1", "attacker"),
        new PlayerInfo("defender", PlayerType.Human, "c2", "defender"),
        ...(needSecond
          ? [new PlayerInfo("defender2", PlayerType.Human, "c3", "defender2")]
          : []),
      ],
      undefined,
      SamLabConfig,
    );
    const attacker = game.player("attacker");
    const defender = game.player("defender");
    const defenders = needSecond
      ? [defender, game.player("defender2")]
      : [defender];

    const siloLevel = opts.siloLevel ?? 1;
    const siloTile = game.ref(SILO.x, SILO.y);
    attacker.conquer(siloTile);
    const silo = attacker.buildUnit(UnitType.MissileSilo, siloTile, {});
    for (let l = 1; l < siloLevel; l++) silo.increaseLevel();
    game.addExecution(new MissileSiloExecution(silo));

    // MIRV warheads need a lot of owned land (55-tile spacing), atoms do not.
    const [x0, x1, y0, y1] = opts.wide ? [55, 199, 0, 199] : [50, 70, 90, 110];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) defender.conquer(game.ref(x, y));
    }

    const owners: Player[] = [];
    const sams = opts.sams.map((p) => {
      const owner = defenders[p.owner ?? 0];
      owners.push(owner);
      // A real PlayerExecution deletes structures standing on tiles the owner
      // does not hold, so give every SAM a small plot of its own. Only then:
      // extra owned land would change where MIRV warheads can be aimed.
      if (opts.playerExecs) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dy = -2; dy <= 2; dy++) {
            const t = game.ref(p.x + dx, p.y + dy);
            if (game.owner(t) !== owner) owner.conquer(t);
          }
        }
      }
      const sam = owner.buildUnit(UnitType.SAMLauncher, game.ref(p.x, p.y), {});
      for (let l = 1; l < (p.level ?? SAM_LEVEL); l++) sam.increaseLevel();
      return sam;
    });
    if (opts.playerExecs) {
      for (const d of defenders) game.addExecution(new PlayerExecution(d));
    }
    return new EdgeLab(
      game,
      attacker,
      defender,
      sams,
      owners,
      opts.order,
      opts.verbose ?? false,
      siloLevel,
    );
  }

  /**
   * Wrap a world built elsewhere (see SamBattlefield): the caller has already
   * created the players, silo (with its MissileSiloExecution), territory and
   * SAMs at their final levels; this adds the logging execs and warms up.
   */
  static fromGame(
    game: Game,
    attacker: Player,
    defender: Player,
    sams: Unit[],
    opts: { order?: Order; verbose?: boolean; siloLevel?: number } = {},
  ): EdgeLab {
    return new EdgeLab(
      game,
      attacker,
      defender,
      sams,
      sams.map(() => defender),
      opts.order ?? "samFirst",
      opts.verbose ?? false,
      opts.siloLevel ?? 1,
    );
  }

  private addSamExec(sam: Unit, idx: number): LoggedSamExec {
    const exec = new LoggedSamExec(this.owners[idx], sam, idx, this);
    this.game.addExecution(exec);
    return exec;
  }

  /** Run `fn` inside tick `relTick` at position `pos` of the execution order. */
  schedule(
    relTick: number,
    pos: HookPos,
    label: string,
    fn: () => void,
    affectsLook = false,
  ): void {
    this.hooks.push({ relTick, pos, label, fn, done: false, affectsLook });
  }

  runHooks(ticks: number, pos: HookPos): void {
    for (const h of this.hooks) {
      if (h.done || h.pos !== pos || h.relTick + this.t0 !== ticks) continue;
      h.done = true;
      h.fn();
      this.lines.push(`t=${this.rel(ticks)} [動作@${pos}] ${h.label}`);
    }
  }

  /** The current game tick, relative to the start of the experiment. */
  relNow(): number {
    return this.game.ticks() - this.t0;
  }

  // ----- launching -----

  launchAtom(waitTicks: number): void {
    const dst = this.game.ref(TARGET.x, TARGET.y);
    this.game.addExecution(
      new NukeExecution(
        UnitType.AtomBomb,
        this.attacker,
        dst,
        null,
        -1,
        waitTicks,
      ),
    );
    if (this.order === "nukeFirst") this.reorderSams();
  }

  launchMirv(): void {
    this.launchMirvAt(this.game.ref(TARGET.x, TARGET.y));
  }

  /** Launch an atom or hydrogen bomb at any tile. */
  launchNuke(
    type: UnitType.AtomBomb | UnitType.HydrogenBomb,
    dst: number,
    waitTicks = 0,
  ): void {
    this.game.addExecution(
      new NukeExecution(type, this.attacker, dst, null, -1, waitTicks),
    );
    if (this.order === "nukeFirst") this.reorderSams();
  }

  launchMirvAt(dst: number): void {
    this.mirv = new MirvExecution(this.attacker, dst);
    this.game.addExecution(this.mirv);
  }

  /** Make the SAM execs run after everything created up to this moment. */
  private reorderSams(): void {
    if (this.reordered) return;
    this.reordered = true;
    for (const e of this.samExecs) e.paused = true;
    this.samExecs = this.sams.map((s, i) => this.addSamExec(s, i));
  }

  step(ticks = 1): void {
    for (let i = 0; i < ticks; i++) {
      this.game.executeNextTick();
      if (
        this.order === "nukeFirst" &&
        this.mirv !== null &&
        (this.mirv as unknown as { warheadsSpawned: boolean }).warheadsSpawned
      ) {
        this.reorderSams();
      }
      this.observe();
    }
  }

  runUntilDone(maxTicks = 200): void {
    for (let i = 0; i < maxTicks; i++) {
      this.step();
      const started = this.records.size > 0 || this.mirv !== null;
      if (started && this.prevAlive.size === 0 && this.mirvDone()) return;
    }
  }

  private mirvDone(): boolean {
    return this.mirv === null || !this.mirv.isActive();
  }

  rel(tick: number): number {
    return tick - this.t0;
  }

  // ----- hooks called by LoggedSamExec -----

  samBefore(cache: CacheView): Pre {
    const locked = new Set<number>();
    for (const n of this.allNukes()) if (n.targetedBySAM()) locked.add(n.id());
    return { locked, cache };
  }

  samAfter(idx: number, ticks: number, pre: Pre, post: CacheView): void {
    const sam = this.sams[idx];
    for (const n of this.allNukes()) {
      const id = n.id();
      // In "nukeFirst" order a SAM can lock a nuke in the very tick it is
      // built, before observe() has seen it, so create the record here.
      const rec = this.ensureRecord(n, ticks, ticks, false);
      const seen = post.get(id)?.tick ?? pre.cache.get(id)?.tick;
      if (seen !== undefined && !rec.cached[idx].includes(seen)) {
        rec.cached[idx].push(seen);
      }
      if (n.targetedBySAM() && !pre.locked.has(id)) {
        rec.locks.push({
          tick: ticks,
          sam: idx,
          cachedBefore: pre.cache.get(id)?.tick ?? null,
          samLevel: sam.level(),
          rangeNow: this.game.config().dynamicSamRange(sam, ticks),
          nukeIdx: n.trajectoryIndex(),
          nukeWait: n.nukeState().waitTicks ?? 0,
          trajTiles: n.trajectory().map((t) => t.tile),
          tile: null,
          tileDist: null,
          rangeAtArrival: null,
          overRange: false,
        });
      }
    }
  }

  // ----- observation -----

  private allNukes(): Unit[] {
    return [
      ...this.attacker.units(UnitType.AtomBomb),
      ...this.attacker.units(UnitType.HydrogenBomb),
      ...this.attacker.units(UnitType.MIRVWarhead),
    ];
  }

  private feasible(
    nuke: Unit,
    sam: Unit,
    t: number,
    advance: boolean,
  ): boolean {
    return samFeasible(this.game, nuke, sam, t, advance);
  }

  private readInterceptCount(): number {
    const all = this.game.stats().stats() as unknown as Record<
      string,
      BombStats
    >;
    let intercept = 0;
    for (const p of Object.values(all)) {
      for (const key of BOMB_KEYS) {
        intercept += Number(p.bombs?.[key]?.[BOMB_INDEX_INTERCEPT] ?? 0n);
      }
    }
    return intercept;
  }

  /** SAMs that could still meet `nuke` at their look on tick `t`. */
  private feasibleSams(nuke: Unit, t: number, advance: boolean): number[] {
    return this.sams
      .map((s, i) => (this.feasible(nuke, s, t, advance) ? i : -1))
      .filter((i) => i >= 0);
  }

  /**
   * `t`/`advance` describe the next SAM look at this nuke: normally the next
   * tick, seeing the state advanced by one nuke step when nukes run first. For
   * a nuke just built in a tick where a SAM already ran after it, pass the
   * look that SAM just made (that tick, state as is).
   */
  private readyCount(samIdx: number[]): number {
    return samIdx.reduce(
      (sum, i) =>
        sum + this.sams[i].level() - this.sams[i].missileTimerQueue().length,
      0,
    );
  }

  private ensureRecord(
    n: Unit,
    tk: number,
    t: number,
    advance: boolean,
    disturbed = false,
  ): EdgeRecord {
    const existing = this.records.get(n.id());
    if (existing !== undefined) return existing;
    const rec = this.newRecord(n, tk, this.feasibleSams(n, t, advance));
    if (rec.feasibleAtSpawn.length > 0 && !disturbed) {
      rec.feasibleEver = true;
      rec.firstFeasibleTick = tk;
      rec.lastFeasibleTick = tk;
      rec.readyAtLastFeasible = this.readyCount(rec.feasibleAtSpawn);
    }
    this.records.set(rec.id, rec);
    if (rec.kind === "warhead") this.mirvWarheadCount++;
    return rec;
  }

  private newRecord(
    n: Unit,
    tk: number,
    feasibleAtSpawn: number[],
  ): EdgeRecord {
    return {
      id: n.id(),
      kind:
        n.type() === UnitType.AtomBomb
          ? "atom"
          : n.type() === UnitType.HydrogenBomb
            ? "hydrogen"
            : "warhead",
      spawnTick: tk,
      waitTicks: n.nukeState().waitTicks ?? 0,
      trajLen: n.trajectory().length,
      feasibleAtSpawn,
      feasibleEver: false,
      firstFeasibleTick: -1,
      lastFeasibleTick: -1,
      cached: this.sams.map(() => []),
      locks: [],
      missileFirstSeen: -1,
      missileGone: -1,
      missileLastDist: null,
      missileLastTile: null,
      fate: "PENDING",
      fateTick: -1,
      flagTrace: [],
      residualStreak: 0,
      maxResidualStreak: 0,
      feasibleAfterClear: false,
      readyAtLastFeasible: 0,
    };
  }

  /**
   * Reads the tile each fresh SAM missile flies to straight from its
   * execution (the cache entry is gone by the time a SAM fires immediately),
   * then judges that tile against the range the engine checks: the SAM's
   * dynamic range at the moment the nuke would reach it.
   */
  private resolveLockTiles(): void {
    const g = this.game;
    const cfg = g.config();
    const speed = cfg.defaultSamMissileSpeed();
    const execs = (g as unknown as { execs: unknown[] }).execs;
    for (const e of execs) {
      const m = e as { target?: Unit; targetTile?: number; ownerUnit?: Unit };
      if (
        m.targetTile === undefined ||
        m.target === undefined ||
        m.ownerUnit === undefined
      ) {
        continue;
      }
      const rec = this.records.get(m.target.id());
      const samIdx = this.sams.indexOf(m.ownerUnit);
      const lock = rec?.locks.find((l) => l.sam === samIdx && l.tile === null);
      if (rec === undefined || lock === undefined) continue;
      const sam = this.sams[samIdx];
      lock.tile = m.targetTile;
      lock.tileDist = Math.sqrt(g.euclideanDistSquared(sam.tile(), lock.tile));
      const samTicks = Math.ceil(
        g.manhattanDist(sam.tile(), lock.tile) / speed,
      );
      const at = lock.trajTiles.indexOf(lock.tile);
      const nukeTicks = at >= 0 ? at - lock.nukeIdx + lock.nukeWait : samTicks;
      lock.rangeAtArrival = cfg.dynamicSamRange(
        sam,
        lock.tick + Math.max(samTicks, nukeTicks),
      );
      // The engine also accepts a tile outside range if the detonation tile
      // is inside it (checkDetonationInterception).
      const finalTile = lock.trajTiles[lock.trajTiles.length - 1];
      const expTicks = lock.trajTiles.length - 1 - lock.nukeIdx + lock.nukeWait;
      const finalRange = cfg.dynamicSamRange(sam, lock.tick + expTicks);
      const finalOk =
        g.euclideanDistSquared(sam.tile(), finalTile) <=
        finalRange * finalRange;
      lock.overRange = lock.tileDist > lock.rangeAtArrival + 1e-6 && !finalOk;
    }
  }

  /** Tracks every SAM missile; returns the nuke ids that have a live one. */
  private trackMissiles(tk: number): Set<number> {
    const live = new Set<number>();
    const targeted = new Set<number>();
    for (const owner of new Set(this.owners)) {
      for (const m of owner.units(UnitType.SAMMissile)) {
        const target = m.targetUnit()?.id();
        live.add(m.id());
        if (target === undefined) continue;
        targeted.add(target);
        const known = this.missiles.get(m.id());
        if (known !== undefined) {
          known.lastTile = m.tile();
          continue;
        }
        this.missiles.set(m.id(), { target, seen: tk, lastTile: m.tile() });
        const rec = this.records.get(target);
        if (rec !== undefined && rec.missileFirstSeen < 0) {
          rec.missileFirstSeen = tk;
        }
      }
    }
    for (const [mid, info] of this.missiles) {
      if (live.has(mid)) continue;
      const rec = this.records.get(info.target);
      if (rec !== undefined) {
        rec.missileGone = tk;
        rec.missileLastTile = info.lastTile;
        const fired = rec.locks[rec.locks.length - 1];
        if (fired !== undefined) {
          rec.missileLastDist = Math.sqrt(
            this.game.euclideanDistSquared(
              this.sams[fired.sam].tile(),
              info.lastTile,
            ),
          );
        }
      }
      this.missiles.delete(mid);
    }
    return targeted;
  }

  /** Flag history, and "flag set but no live SAM missile" streaks. */
  private trackFlag(
    n: Unit,
    rec: EdgeRecord,
    tk: number,
    targeted: Set<number>,
  ) {
    const flag = n.targetedBySAM();
    const prev = this.prevFlag.get(n.id());
    if (prev !== flag) rec.flagTrace.push({ tick: tk, value: flag });
    this.prevFlag.set(n.id(), flag);
    if (flag && !targeted.has(n.id())) {
      rec.residualStreak++;
      rec.maxResidualStreak = Math.max(
        rec.maxResidualStreak,
        rec.residualStreak,
      );
    } else {
      rec.residualStreak = 0;
    }
  }

  private samStatus(): string {
    const cfg = this.game.config();
    const t = this.game.ticks();
    return this.sams
      .map((s, i) =>
        s.isActive()
          ? `S${i}(L${s.level()},rng=${cfg.dynamicSamRange(s, t).toFixed(1)},rdy=${s.level() - s.missileTimerQueue().length})`
          : `S${i}(已毀)`,
      )
      .join(" ");
  }

  private observe(): void {
    const tk = this.game.ticks() - 1; // the tick that just ran
    const upcoming = this.game.ticks();
    const nukeRunsFirst = this.order === "nukeFirst";
    const alive = new Set<number>();
    const parts: string[] = [];
    const targeted = this.trackMissiles(tk);
    this.resolveLockTiles();
    // A scheduled level change lands between this evaluation and the SAM's
    // next look, so what we compute now would not be what the SAM sees.
    const disturbed = this.hooks.some(
      (h) => !h.done && h.affectsLook && h.relTick + this.t0 === upcoming,
    );

    for (const n of this.allNukes()) {
      const id = n.id();
      alive.add(id);
      this.unitsById.set(id, n);
      const rec = this.ensureRecord(n, tk, upcoming, nukeRunsFirst, disturbed);
      const fe = this.feasibleSams(n, upcoming, nukeRunsFirst);
      if (fe.length > 0 && !disturbed) {
        rec.feasibleEver = true;
        if (rec.firstFeasibleTick < 0) rec.firstFeasibleTick = tk;
        rec.lastFeasibleTick = tk;
        rec.readyAtLastFeasible = this.readyCount(fe);
      }
      this.trackFlag(n, rec, tk, targeted);
      const cleared =
        !n.targetedBySAM() && rec.flagTrace.some((f) => f.value === true);
      if (cleared && fe.length > 0) rec.feasibleAfterClear = true;
      parts.push(
        `#${id}(w=${n.nukeState().waitTicks ?? 0},idx=${n.trajectoryIndex()}/${rec.trajLen},fe=[${fe}],lock=${n.targetedBySAM() ? 1 : 0},飛彈=${targeted.has(id) ? 1 : 0})`,
      );
    }

    // A nuke is only marked reachedTarget() when it detonates, so that tells
    // landed from intercepted per nuke. (Matching the intercept counter to
    // whichever nukes vanish in a tick can pin the label on the wrong one when
    // two vanish together.)
    this.prevIntercept = this.readInterceptCount();
    const gone = [...this.prevAlive].filter((id) => !alive.has(id));
    for (const id of gone) {
      const rec = this.records.get(id);
      if (rec === undefined) continue;
      rec.fateTick = tk;
      rec.fate = this.unitsById.get(id)?.reachedTarget()
        ? "LANDED"
        : "INTERCEPTED";
      this.unitsById.delete(id);
    }
    this.prevAlive = alive;

    if (this.verbose && (parts.length > 0 || gone.length > 0)) {
      const goneText = gone
        .map((id) => `#${id}=${this.records.get(id)?.fate}`)
        .join(",");
      this.lines.push(
        `t=${this.rel(tk)} ${this.samStatus()} | 核彈: ${parts.join(" ") || "-"}` +
          (gone.length > 0 ? ` | 消失: ${goneText}` : ""),
      );
    }
  }

  // ----- reporting -----

  describe(r: EdgeRecord): string {
    const rel = (v: number) => (v < 0 ? "-" : String(this.rel(v)));
    const cachedText = r.cached
      .map(
        (c, i) =>
          `S${i}:[${c.map((v) => (v < 0 ? v : this.rel(v))).join(",")}]`,
      )
      .join(" ");
    const fireText =
      r.locks
        .map((l) => {
          const c =
            l.cachedBefore === null
              ? "無"
              : l.cachedBefore < 0
                ? l.cachedBefore
                : this.rel(l.cachedBefore);
          const dist = l.tileDist === null ? "-" : l.tileDist.toFixed(1);
          const arr =
            l.rangeAtArrival === null ? "-" : l.rangeAtArrival.toFixed(1);
          return `S${l.sam}@${this.rel(l.tick)}(L${l.samLevel},rng=${l.rangeNow.toFixed(1)},抵達時rng=${arr},攔截點距離=${dist},cached=${c})`;
        })
        .join(",") || "無";
    const flagText =
      r.flagTrace
        .map((f) => `${this.rel(f.tick)}:${f.value ? 1 : 0}`)
        .join(",") || "-";
    return (
      `核彈#${r.id}[${r.kind}] spawn@${this.rel(r.spawnTick)} wait=${r.waitTicks} 軌跡長=${r.trajLen}` +
      ` | 各塔cached.tick=${cachedText}` +
      ` | 開火=${fireText}` +
      ` | 先鎖定=${r.locks[0] === undefined ? "-" : `S${r.locks[0].sam}`}` +
      ` | 旗標變化(tick:值)=${flagText} 殘留最長=${r.maxResidualStreak}tick` +
      ` | 飛彈存活=${rel(r.missileFirstSeen)}~${rel(r.missileGone)} 飛彈末位離塔=${r.missileLastDist === null ? "-" : r.missileLastDist.toFixed(1)}` +
      ` | 結果=${r.fate}@${rel(r.fateTick)}` +
      ` | 曾可行=${r.feasibleEver}(${rel(r.firstFeasibleTick)}~${rel(r.lastFeasibleTick)})` +
      ` | 分類=${edgeClass(r)}`
    );
  }

  /** Over-range shots, lingering flags, and feasible-but-nobody-took-over. */
  anomalies(): string[] {
    const out: string[] = [];
    for (const r of this.records.values()) {
      for (const l of r.locks) {
        if (l.overRange && l.tileDist !== null && l.rangeAtArrival !== null) {
          out.push(
            `超射程開火 核彈#${r.id} S${l.sam}@${this.rel(l.tick)} 攔截點距離=${l.tileDist.toFixed(1)} > 抵達時射程=${l.rangeAtArrival.toFixed(1)} (開火時L${l.samLevel} 射程=${l.rangeNow.toFixed(1)}) 結果=${r.fate}`,
          );
        }
      }
      if (r.maxResidualStreak >= 2) {
        out.push(
          `旗標殘留 核彈#${r.id} 旗標為真但無存活SAM飛彈 連續${r.maxResidualStreak}tick 結果=${r.fate}@${this.rel(r.fateTick)}`,
        );
      }
      if (r.fate === "LANDED" && r.feasibleAfterClear) {
        out.push(
          `可行卻沒人接手 核彈#${r.id} 旗標清除後仍有塔可行,卻落地@${this.rel(r.fateTick)}`,
        );
      }
      if (
        edgeClass(r) === "BUG_FEASIBLE_NO_SHOT" &&
        r.readyAtLastFeasible > 0
      ) {
        out.push(
          `可行卻沒開火 核彈#${r.id}(最後可行的tick仍有${r.readyAtLastFeasible}個ready彈匣,卻從未被鎖定)`,
        );
      }
    }
    return out;
  }

  tally(): Record<EdgeClass, number> & { total: number; landed: number } {
    const t = {
      INTERCEPTED: 0,
      LEAK_INFEASIBLE: 0,
      BUG_FEASIBLE_NO_SHOT: 0,
      BUG_LOCKED_BUT_LANDED: 0,
      PENDING: 0,
      total: 0,
      landed: 0,
    };
    for (const r of this.records.values()) {
      t[edgeClass(r)]++;
      t.total++;
      if (r.fate === "LANDED") t.landed++;
    }
    return t;
  }
}

// ----- layout helpers (pure) -----

export function minDist(p: Placement, pts: Placement[]): number {
  let best = Infinity;
  for (const q of pts) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
  return best;
}

/** On row `y`, the column east of the target whose nearest-trajectory distance is closest to `d`. */
export function placeAtDistance(
  y: number,
  d: number,
  traj: Placement[],
): Placement {
  let best: Placement = { x: 199, y };
  let bestErr = Infinity;
  for (let x = TARGET.x; x <= 199; x++) {
    const err = Math.abs(minDist({ x, y }, traj) - d);
    if (err < bestErr) {
      bestErr = err;
      best = { x, y };
    }
  }
  return best;
}

/** Probe the real trajectory of an atom bomb from the silo to the target. */
export async function probeTrajectory(): Promise<Placement[]> {
  const lab = await EdgeLab.create({ sams: [], order: "samFirst" });
  lab.launchAtom(0);
  lab.step(2);
  const nuke = lab.attacker.units(UnitType.AtomBomb)[0];
  return nuke
    .trajectory()
    .map((t) => ({ x: lab.game.x(t.tile), y: lab.game.y(t.tile) }));
}
