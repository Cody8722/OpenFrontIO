import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  BOMB_INDEX_INTERCEPT,
  BOMB_INDEX_LAND,
  unitTypeToBombUnit,
} from "@openfront/engine-api/StatsSchemas";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { MissileSiloExecution } from "@openfront/engine/execution/MissileSiloExecution";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { SAMLauncherExecution } from "@openfront/engine/execution/SAMLauncherExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./Setup";
import { TestConfig } from "./TestConfig";

// TestConfig flattens nuke speed to 4 and SAM range to 20. For a SAM-capacity
// study those must be the production values; only the blast size stays tiny so
// a landed nuke does not destroy the SAMs and poison later measurements.
export class SamLabConfig extends TestConfig {
  nukeSpeed(type: UnitType): number {
    return EngineConfig.prototype.nukeSpeed.call(this, type);
  }
  defaultNukeTargetableRange(): number {
    return EngineConfig.prototype.defaultNukeTargetableRange.call(this);
  }
  defaultSamRange(): number {
    return EngineConfig.prototype.defaultSamRange.call(this);
  }
  samRange(level: number): number {
    return EngineConfig.prototype.samRange.call(this, level);
  }
}

export const SILO_POS = { x: 10, y: 100 };
export const TARGET_POS = { x: 150, y: 100 };
const WARMUP_TICKS = 100;
const ATOM_KEY = unitTypeToBombUnit[UnitType.AtomBomb];

export type Fate = "PENDING" | "INTERCEPTED" | "LANDED";

export type MissReason =
  | "NEVER_FEASIBLE"
  | "ALL_SLOTS_COOLING_AT_LAST_CHANCE"
  | "SHOT_FIRED_BUT_NOT_INTERCEPTED"
  | "CANDIDATE_BUG_READY_AT_LAST_CHANCE_NO_SHOT";

/**
 * "Feasible" mirrors SAMTargetingSystem.computeInterceptionTile: a SAM fired
 * this tick could still meet the nuke on some targetable trajectory tile that
 * is inside the SAM's (dynamic) range and reachable at SAM missile speed.
 */
export interface NukeRecord {
  id: number;
  launchTick: number;
  fate: Fate;
  fateTick: number;
  feasibleTicks: number;
  firstFeasibleTick: number;
  lastFeasibleTick: number;
  /** Total ready slots across SAMs that were feasible at lastFeasibleTick. */
  readyAtLastFeasible: number;
  /** Number of feasible ticks on which some feasible SAM had a ready slot. */
  feasibleReadyTicks: number;
  targetedTick: number;
}

export interface LabEvent {
  tick: number;
  text: string;
}

export interface Summary {
  launched: number;
  intercepted: number;
  landed: number;
  pending: number;
}

type BombStats = { bombs?: Record<string, bigint[]> };

export function missReason(rec: NukeRecord): MissReason | null {
  if (rec.fate !== "LANDED") return null;
  if (rec.targetedTick >= 0) return "SHOT_FIRED_BUT_NOT_INTERCEPTED";
  if (rec.feasibleTicks === 0) return "NEVER_FEASIBLE";
  if (rec.readyAtLastFeasible === 0) return "ALL_SLOTS_COOLING_AT_LAST_CHANCE";
  return "CANDIDATE_BUG_READY_AT_LAST_CHANCE_NO_SHOT";
}

export class SamLab {
  readonly records = new Map<number, NukeRecord>();
  readonly events: LabEvent[] = [];
  readonly lines: string[] = [];
  /** Game tick at which the experiment clock starts (after warm-up). */
  readonly t0: number;
  requested = 0;

  private prevAlive = new Set<number>();
  private prevQueue: number[][];
  private prevIntercept = 0;
  private prevLand = 0;

  private constructor(
    readonly game: Game,
    readonly attacker: Player,
    readonly defender: Player,
    readonly sams: Unit[],
    private readonly verbose: boolean,
  ) {
    this.t0 = game.ticks();
    this.prevQueue = sams.map((s) => [...s.missileTimerQueue()]);
    const stats = this.readStats();
    this.prevIntercept = stats.intercept;
    this.prevLand = stats.land;
  }

  /**
   * Builds attacker (one silo of `siloLevel`) and defender (SAMs of
   * `samLevels`, one launcher each), then warms up so every magazine slot
   * created by increaseLevel() has finished its first reload.
   */
  static async create(
    samLevels: number[],
    siloLevel: number,
    verbose = false,
  ): Promise<SamLab> {
    const game = await setup(
      "big_plains",
      { infiniteGold: true, instantBuild: true },
      [
        new PlayerInfo("attacker", PlayerType.Human, "c1", "attacker"),
        new PlayerInfo("defender", PlayerType.Human, "c2", "defender"),
      ],
      undefined,
      SamLabConfig,
    );
    const attacker = game.player("attacker");
    const defender = game.player("defender");

    const siloTile = game.ref(SILO_POS.x, SILO_POS.y);
    attacker.conquer(siloTile);
    const silo = attacker.buildUnit(UnitType.MissileSilo, siloTile, {});
    for (let i = 1; i < siloLevel; i++) silo.increaseLevel();
    // Without this the silo magazine never reloads (like SAMLauncherExecution).
    game.addExecution(new MissileSiloExecution(silo));

    for (let x = 130; x <= 165; x++) {
      for (let y = 90; y <= 110; y++) defender.conquer(game.ref(x, y));
    }
    const sams = samLevels.map((level, i) => {
      const tile = game.ref(138 + (i % 5) * 2, 96 + Math.floor(i / 5) * 2);
      const sam = defender.buildUnit(UnitType.SAMLauncher, tile, {});
      for (let l = 1; l < level; l++) sam.increaseLevel();
      game.addExecution(new SAMLauncherExecution(defender, null, sam));
      return sam;
    });

    // MissileSiloExecution reloads one slot per tick (SAMs drain all expired
    // slots in a loop), so a level-L silo needs L extra ticks after cooldown.
    for (let i = 0; i < WARMUP_TICKS + siloLevel; i++) game.executeNextTick();
    const lab = new SamLab(game, attacker, defender, sams, verbose);
    for (const [i, s] of sams.entries()) {
      const ready = s.level() - s.missileTimerQueue().length;
      if (ready !== s.level()) {
        lab.lines.push(`[警告] 暖機後 SAM#${i} 仍未全部裝填 ready=${ready}`);
      }
    }
    return lab;
  }

  /** Queue `count` atom bomb launches from the silo at the target tile. */
  launch(count = 1): void {
    const target = this.game.ref(TARGET_POS.x, TARGET_POS.y);
    for (let i = 0; i < count; i++) {
      this.game.addExecution(
        new NukeExecution(UnitType.AtomBomb, this.attacker, target, null),
      );
      this.requested++;
    }
  }

  step(ticks = 1): void {
    for (let i = 0; i < ticks; i++) {
      this.game.executeNextTick();
      this.observe();
    }
  }

  /** Run until every requested nuke has resolved (or `maxTicks` elapsed). */
  drain(maxTicks = 300): void {
    for (let i = 0; i < maxTicks; i++) {
      if (this.records.size >= this.requested && this.prevAlive.size === 0) {
        return;
      }
      this.step();
    }
  }

  summary(): Summary {
    const s: Summary = { launched: 0, intercepted: 0, landed: 0, pending: 0 };
    for (const r of this.records.values()) {
      s.launched++;
      if (r.fate === "INTERCEPTED") s.intercepted++;
      else if (r.fate === "LANDED") s.landed++;
      else s.pending++;
    }
    return s;
  }

  rel(tick: number): number {
    return tick - this.t0;
  }

  dump(title: string): string {
    const out = [`===== ${title} =====`, ...this.lines];
    for (const r of this.records.values()) {
      out.push(
        `核彈#${r.id} 發射@${this.rel(r.launchTick)} 結果=${r.fate}@${this.rel(r.fateTick)}` +
          ` 可攔截期=${r.feasibleTicks}tick(${this.rel(r.firstFeasibleTick)}~${this.rel(r.lastFeasibleTick)})` +
          ` 其中有ready=${r.feasibleReadyTicks}tick 最後機會ready=${r.readyAtLastFeasible}` +
          ` 鎖定@${r.targetedTick < 0 ? "-" : this.rel(r.targetedTick)}` +
          ` 漏掉原因=${missReason(r) ?? "-"}`,
      );
    }
    return out.join("\n");
  }

  /** Same conditions as SAMTargetingSystem.computeInterceptionTile's loop. */
  private feasible(nuke: Unit, sam: Unit, t: number): boolean {
    const g = this.game;
    const cfg = g.config();
    const trajectory = nuke.trajectory();
    const cur = nuke.trajectoryIndex();
    const wait = nuke.nukeState().waitTicks ?? 0;
    const speed = cfg.defaultSamMissileSpeed();
    for (let i = cur; i <= trajectory.length - 2; i++) {
      const tile = trajectory[i];
      const nukeTicks = i - cur + wait;
      const samTicks = Math.ceil(
        g.manhattanDist(sam.tile(), tile.tile) / speed,
      );
      const allowed = cfg.dynamicSamRange(sam, t + nukeTicks);
      if (
        tile.targetable &&
        g.euclideanDistSquared(sam.tile(), tile.tile) <= allowed * allowed &&
        nukeTicks >= samTicks
      ) {
        return true;
      }
    }
    return false;
  }

  private readStats(): { intercept: number; land: number } {
    const all = this.game.stats().stats() as unknown as Record<
      string,
      BombStats
    >;
    let intercept = 0;
    let land = 0;
    for (const p of Object.values(all)) {
      const arr = p.bombs?.[ATOM_KEY];
      if (arr === undefined) continue;
      intercept += Number(arr[BOMB_INDEX_INTERCEPT] ?? 0n);
      land += Number(arr[BOMB_INDEX_LAND] ?? 0n);
    }
    return { intercept, land };
  }

  private observe(): void {
    const g = this.game;
    const t = g.ticks();
    const events: string[] = [];
    const samState = this.sams.map((s, i) => {
      const q = [...s.missileTimerQueue()];
      // Queue entries are launch ticks in increasing order, so a fire is an
      // entry newer than everything seen last time. Comparing lengths alone
      // hides a reload and a fire in the same tick.
      const prev = this.prevQueue[i];
      const prevNewest = prev.length > 0 ? prev[prev.length - 1] : -1;
      const fires = q.filter((x) => x > prevNewest).length;
      const reloads = prev.length + fires - q.length;
      if (fires > 0) events.push(`SAM#${i} 發射×${fires}`);
      if (reloads > 0) events.push(`SAM#${i} 裝填×${reloads}`);
      this.prevQueue[i] = q;
      return { q, ready: s.level() - q.length };
    });

    const alive = new Set<number>();
    const nukeParts: string[] = [];
    const targetTile = g.ref(TARGET_POS.x, TARGET_POS.y);
    for (const n of this.attacker.units(UnitType.AtomBomb)) {
      const id = n.id();
      alive.add(id);
      let rec = this.records.get(id);
      if (rec === undefined) {
        rec = {
          id,
          launchTick: t,
          fate: "PENDING",
          fateTick: -1,
          feasibleTicks: 0,
          firstFeasibleTick: -1,
          lastFeasibleTick: -1,
          readyAtLastFeasible: 0,
          feasibleReadyTicks: 0,
          targetedTick: -1,
        };
        this.records.set(id, rec);
        events.push(`核彈#${id} 出現`);
      }
      let readyFeasible = 0;
      let feasibleSams = 0;
      for (const [i, s] of this.sams.entries()) {
        if (this.feasible(n, s, t)) {
          feasibleSams++;
          readyFeasible += samState[i].ready;
        }
      }
      if (feasibleSams > 0) {
        rec.feasibleTicks++;
        if (rec.firstFeasibleTick < 0) rec.firstFeasibleTick = t;
        rec.lastFeasibleTick = t;
        rec.readyAtLastFeasible = readyFeasible;
        if (readyFeasible > 0) rec.feasibleReadyTicks++;
      }
      if (n.targetedBySAM() && rec.targetedTick < 0) {
        rec.targetedTick = t;
        events.push(`核彈#${id} 被鎖定`);
      }
      const dst = Math.sqrt(g.euclideanDistSquared(n.tile(), targetTile));
      nukeParts.push(
        `#${id}(d=${dst.toFixed(0)},tg=${n.isTargetable() ? 1 : 0},fe=${feasibleSams},rdy=${readyFeasible},lock=${n.targetedBySAM() ? 1 : 0})`,
      );
    }

    const stats = this.readStats();
    const dI = stats.intercept - this.prevIntercept;
    const dL = stats.land - this.prevLand;
    this.prevIntercept = stats.intercept;
    this.prevLand = stats.land;
    // A nuke that was locked on is the likelier one to have been shot down.
    const gone = [...this.prevAlive]
      .filter((id) => !alive.has(id))
      .sort((a, b) => {
        const lockedA = (this.records.get(a)?.targetedTick ?? -1) >= 0 ? 1 : 0;
        const lockedB = (this.records.get(b)?.targetedTick ?? -1) >= 0 ? 1 : 0;
        return lockedB - lockedA;
      });
    let interceptsLeft = dI;
    for (const id of gone) {
      const rec = this.records.get(id);
      if (rec === undefined) continue;
      rec.fateTick = t;
      if (interceptsLeft > 0) {
        rec.fate = "INTERCEPTED";
        interceptsLeft--;
        events.push(`核彈#${id} 被擊落`);
      } else {
        rec.fate = "LANDED";
        events.push(`核彈#${id} 落地`);
      }
    }
    if (gone.length !== dI + dL) {
      events.push(`[警告] 消失${gone.length}顆但統計 攔截${dI}+落地${dL}`);
    }
    this.prevAlive = alive;

    for (const e of events) this.events.push({ tick: t, text: e });
    if (this.verbose) {
      const samText = samState
        .map(
          (s, i) =>
            `SAM#${i} rdy=${s.ready}/${this.sams[i].level()} q=[${s.q.map((x) => x - this.t0).join(",")}]`,
        )
        .join(" ");
      this.lines.push(
        `t=${this.rel(t)} ${samText} | 核彈: ${nukeParts.join(" ") || "-"}` +
          (events.length > 0 ? ` | 事件: ${events.join("; ")}` : ""),
      );
    } else if (events.length > 0) {
      this.lines.push(`t=${this.rel(t)} ${events.join("; ")}`);
    }
  }
}
