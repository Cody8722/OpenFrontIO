// Nuke lab on top of the fortress-siege world: can nukes shrink a billion-scale
// attack, past the nation's SAMs? Real engine rules (SiegeConfig extends
// EngineConfig); the SAM feasibility test is the earlier lab's samFeasible,
// reused as is. Logs go to .fortress-siege-data/nuke/nuke.log.
import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
  TrajectoryTile,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { MissileSiloExecution } from "@openfront/engine/execution/MissileSiloExecution";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { SAMLauncherExecution } from "@openfront/engine/execution/SAMLauncherExecution";
import { Unit } from "@openfront/engine/game/Game";
import { UniversalPathFinding } from "@openfront/engine/pathfinding/PathFinder";
import fs from "fs";
import path from "path";
import {
  buildForts,
  coverage,
  DATA_DIR,
  encodePng,
  FortPlan,
  fortPositions,
  placeCities,
  Point,
  SiegeMap,
  siegeMap,
  SiegeWorld,
  siegeWorld,
} from "./FortressSiege";
import { samFeasible } from "./SamEdgeLab";

export const NUKE_DIR = path.join(DATA_DIR, "nuke");
const MARGIN = 10;

export function nlog(line: string): void {
  fs.mkdirSync(NUKE_DIR, { recursive: true });
  fs.appendFileSync(path.join(NUKE_DIR, "nuke.log"), `${line}\n`);
  console.log(line);
}

export const fmtN = (n: number) =>
  Math.abs(n) >= 1e9
    ? `${(n / 1e9).toFixed(3)}B`
    : Math.abs(n) >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n.toFixed(0);

/** Gold prices (EngineConfig.unitCost): atom 750k, hydrogen 5M, silo 1M per level. */
export const PRICE = { atom: 750_000, hydrogen: 5_000_000, silo: 1_000_000 };

// ----------------------------------------------------------------- geometry

export interface Sam {
  x: number;
  y: number;
  level: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The nation block: x in [10, frontX), y in [10, 10 + rows). */
export function nationBox(m: SiegeMap) {
  return { x0: MARGIN, x1: m.frontX - 1, y0: MARGIN, y1: MARGIN + m.rows - 1 };
}

/** A few low-level SAMs at random places (the "sparse" layout). */
export function sparseSams(
  m: SiegeMap,
  seed: number,
  count: number,
  minLevel: number,
  maxLevel: number,
): Sam[] {
  const r = rng(seed);
  const b = nationBox(m);
  const out: Sam[] = [];
  let guard = 0;
  while (out.length < count && guard++ < 10_000) {
    const x = Math.floor(b.x0 + 20 + r() * (b.x1 - b.x0 - 40));
    const y = Math.floor(b.y0 + 20 + r() * (b.y1 - b.y0 - 40));
    if (out.some((s) => (s.x - x) ** 2 + (s.y - y) ** 2 < 15 * 15)) continue;
    out.push({
      x,
      y,
      level: minLevel + Math.floor(r() * (maxLevel - minLevel + 1)),
    });
  }
  return out;
}

/** Share of land tiles inside >= k SAM ranges, and the minimum overlap. */
export function overlapStats(
  m: SiegeMap,
  sams: Sam[],
  rangeOf: (level: number) => number,
  k = 5,
) {
  const b = nationBox(m);
  let total = 0;
  let covered = 0;
  let coveredK = 0;
  let minCover = Infinity;
  for (let y = b.y0; y <= b.y1; y += 6) {
    for (let x = b.x0; x <= b.x1; x += 6) {
      total++;
      let c = 0;
      for (const s of sams) {
        const r = rangeOf(s.level);
        if ((s.x - x) ** 2 + (s.y - y) ** 2 <= r * r) c++;
      }
      if (c >= 1) covered++;
      if (c >= k) coveredK++;
      minCover = Math.min(minCover, c);
    }
  }
  return {
    covered: covered / total,
    coveredK: coveredK / total,
    minCover: Number.isFinite(minCover) ? minCover : 0,
  };
}

/** Largest lattice spacing at which every land tile sits inside >= minOverlap ranges. */
export function denseSams(
  m: SiegeMap,
  rangeOf: (level: number) => number,
  level: number,
  minOverlap: number,
): { sams: Sam[]; spacing: number; minCover: number } {
  const b = nationBox(m);
  for (let s = 140; s >= 30; s -= 5) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let x = b.x0 + 4; x <= b.x1; x += s) xs.push(x);
    for (let y = b.y0 + 4; y <= b.y1; y += s) ys.push(y);
    if (xs[xs.length - 1] < b.x1 - 8) xs.push(b.x1 - 4);
    if (ys[ys.length - 1] < b.y1 - 8) ys.push(b.y1 - 4);
    const sams = ys.flatMap((y) => xs.map((x) => ({ x, y, level })));
    const st = overlapStats(m, sams, rangeOf, minOverlap);
    if (st.minCover >= minOverlap)
      return { sams, spacing: s, minCover: st.minCover };
  }
  throw new Error("no lattice reaches the requested overlap");
}

/** Expected nation tiles one bomb removes (inner fully, outer ring half), clipped to the block. */
export function blastTiles(
  m: SiegeMap,
  tx: number,
  ty: number,
  inner: number,
  outer: number,
): number {
  const b = nationBox(m);
  let k = 0;
  for (
    let y = Math.max(b.y0, ty - outer);
    y <= Math.min(b.y1, ty + outer);
    y++
  ) {
    for (
      let x = Math.max(b.x0, tx - outer);
      x <= Math.min(b.x1, tx + outer);
      x++
    ) {
      const d2 = (x - tx) ** 2 + (y - ty) ** 2;
      if (d2 <= inner * inner) k += 1;
      else if (d2 <= outer * outer) k += 0.5;
    }
  }
  return k;
}

/** Troops left after k of N tiles are hit: prod (1 - 5/(N-i)) ~ ((N-k)/N)^5. */
export function troopFactor(N: number, k: number): number {
  let f = 1;
  for (let i = 0; i < Math.floor(k); i++) f *= 1 - 5 / Math.max(1, N - i);
  return f;
}

// -------------------------------------------------------------- placement

export function placeSams(w: SiegeWorld, sams: Sam[], armed: boolean): Unit[] {
  return sams.map((s) => {
    const unit = w.attacker.buildUnit(
      UnitType.SAMLauncher,
      w.game.ref(s.x, s.y),
      {},
    );
    for (let l = 1; l < s.level; l++) unit.increaseLevel();
    if (armed) {
      w.game.addExecution(new SAMLauncherExecution(w.attacker, null, unit));
    }
    return unit;
  });
}

export function placeSilos(w: SiegeWorld, pts: Point[]): Unit[] {
  return pts.map((p) => {
    const silo = w.defender.buildUnit(
      UnitType.MissileSilo,
      w.game.ref(p.x, p.y),
      {},
    );
    w.game.addExecution(new MissileSiloExecution(silo));
    return silo;
  });
}

// ---------------------------------------------------------- reach analysis

/** The engine's own flight path (same pathfinder call as NukeExecution), with its targetable flags. */
export function trajectoryFor(
  w: SiegeWorld,
  src: TileRef,
  dst: TileRef,
  speed: number,
): TrajectoryTile[] {
  const pf = UniversalPathFinding.Parabola(w.game, {
    increment: speed,
    directionUp: true,
  });
  const range2 = w.config.defaultNukeTargetableRange() ** 2;
  return (pf.findPath(src, dst) ?? []).map((tile) => ({
    tile,
    targetable:
      w.game.euclideanDistSquared(tile, dst) < range2 ||
      w.game.euclideanDistSquared(src, tile) < range2,
  }));
}

/** True when no armed SAM could meet this flight (earlier lab's samFeasible). */
export function corridorFree(
  w: SiegeWorld,
  sams: Unit[],
  traj: TrajectoryTile[],
): boolean {
  const stub = {
    trajectory: () => traj,
    trajectoryIndex: () => 0,
    nukeState: () => ({ waitTicks: 0 }),
  } as unknown as Unit;
  const t = w.game.ticks();
  return !sams.some((s) => samFeasible(w.game, stub, s, t, false));
}

export type TargetClass = "front" | "edge" | "interior";

export function classify(m: SiegeMap, x: number, y: number): TargetClass {
  const b = nationBox(m);
  if (x >= m.frontX - 60) return "front";
  if (x < b.x0 + 40 || y < b.y0 + 40 || y > b.y1 - 40) return "edge";
  return "interior";
}

export interface ReachCell {
  x: number;
  y: number;
  free: boolean;
  cls: TargetClass;
  k: number;
  factor: number;
  silo: number;
}

/** For each grid target: is there a silo whose flight no SAM can meet, and what would the hit do. */
export function reachMap(
  w: SiegeWorld,
  sams: Unit[],
  silos: Point[],
  step: number,
  inner: number,
  outer: number,
  speed: number,
): ReachCell[] {
  const b = nationBox(w.map);
  const N = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  const cells: ReachCell[] = [];
  for (let y = b.y0 + Math.floor(step / 2); y <= b.y1; y += step) {
    for (let x = b.x0 + Math.floor(step / 2); x <= b.x1; x += step) {
      const dst = w.game.ref(x, y);
      let free = false;
      let silo = -1;
      for (let i = 0; i < silos.length && !free; i++) {
        const traj = trajectoryFor(
          w,
          w.game.ref(silos[i].x, silos[i].y),
          dst,
          speed,
        );
        if (traj.length >= 2 && corridorFree(w, sams, traj)) {
          free = true;
          silo = i;
        }
      }
      const k = blastTiles(w.map, x, y, inner, outer);
      cells.push({
        x,
        y,
        free,
        cls: classify(w.map, x, y),
        k,
        factor: troopFactor(N, k),
        silo,
      });
    }
  }
  return cells;
}

/** One PNG: nation land grey, reachable blocks green, covered blocks red, SAMs gold, silos white. */
export function renderReach(
  w: SiegeWorld,
  cells: ReachCell[],
  step: number,
  sams: Sam[],
  silos: Point[],
  file: string,
): void {
  const { map } = w;
  const px = new Uint8Array(map.w * map.h * 3);
  const set = (x: number, y: number, c: number[]) => {
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return;
    const i = (y * map.w + x) * 3;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  };
  const b = nationBox(map);
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const nation = x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
      const mine =
        x >= map.frontX &&
        x < map.frontX + map.defenderCols &&
        y >= b.y0 &&
        y <= b.y1;
      set(x, y, nation ? [70, 78, 90] : mine ? [60, 90, 160] : [28, 40, 56]);
    }
  }
  for (const c of cells) {
    const col = c.free ? [70, 190, 110] : [200, 70, 70];
    for (let dy = 0; dy < step; dy++) {
      for (let dx = 0; dx < step; dx++) {
        set(
          c.x - Math.floor(step / 2) + dx,
          c.y - Math.floor(step / 2) + dy,
          col,
        );
      }
    }
  }
  for (const s of sams) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(s.x + dx, s.y + dy, [255, 215, 0]);
    }
  }
  for (const s of silos) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) set(s.x + dx, s.y + dy, [255, 255, 255]);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(map.w, map.h, px));
}

// ------------------------------------------------------------- scenarios

export interface NukePlanItem {
  /** Ticks after the attack starts. */
  tick: number;
  type: UnitType.AtomBomb | UnitType.HydrogenBomb;
  tx: number;
  ty: number;
  silo: Point;
}

export interface NukeScenario {
  label: string;
  nationTroops: number;
  cityLevels: number;
  difficulty: Difficulty;
  /** Defender's troops; with defCityLevels set the cap comes from cities. */
  defTroops: number;
  defCityLevels?: number;
  fort: FortPlan;
  /** Troops of one all-in attack; omitted = the real NationExecution decides. */
  forcedAttack?: number;
  sams: Sam[];
  nukes: NukePlanItem[];
  frozenNationRegen?: boolean;
  /** Diagnostic: 1-tile blasts, so landed nukes cannot destroy SAMs. */
  tinyBlast?: boolean;
  /** Ticks to wait after placing SAMs/silos before anything starts (default 150). */
  warmup?: number;
  maxTicks: number;
  sampleEvery: number;
  attackerCols?: number;
  defenderCols?: number;
  rows?: number;
}

export interface NukeFate {
  plan: NukePlanItem;
  launched: boolean;
  fate: "landed" | "intercepted" | "pending";
  endTick: number | null;
}

export interface NukeSample {
  tick: number;
  pool: number;
  attack: number;
  defTroops: number;
  defTiles: number;
  nationTiles: number;
  landed: number;
  intercepted: number;
}

export interface NukeScenarioResult {
  label: string;
  samCount: number;
  nukeCount: number;
  fates: NukeFate[];
  landed: number;
  intercepted: number;
  samMissiles: number;
  /** SAM units still standing when the run ended. */
  samsAliveEnd: number;
  nationCap: number;
  poolStart: number;
  attackPeak: number;
  attackEnd: number;
  nationTilesStart: number;
  nationTilesEnd: number;
  defTiles0: number;
  lostTiles: number;
  lostFrac: number;
  tickTo50: number | null;
  tickTo100: number | null;
  defTroopsEnd: number;
  endReason: string;
  ticks: number;
  samples: NukeSample[];
  cost: { atoms: number; hydrogens: number; siloLevels: number; gold: number };
  elapsedMs: number;
}

export async function runNukeScenario(
  s: NukeScenario,
): Promise<NukeScenarioResult> {
  const t0 = performance.now();
  nlog(
    `[scenario] ${s.label} 開始 nation兵=${fmtN(s.nationTroops)} 城市等級=${s.cityLevels} 難度=${s.difficulty} 防守兵=${fmtN(s.defTroops)} fort=${s.fort} SAM=${s.sams.length}座(等級和 ${s.sams.reduce((a, b) => a + b.level, 0)}) 核彈=${s.nukes.length}發 ${s.forcedAttack ? `強制攻擊=${fmtN(s.forcedAttack)}` : "NationExecution 決定"}`,
  );
  const m = siegeMap(
    s.attackerCols ?? 600,
    s.defenderCols ?? 200,
    s.rows ?? 500,
  );
  const w = await siegeWorld(m, {
    attackerType: PlayerType.Nation,
    config: {
      difficulty: s.difficulty,
      nations: "default",
      infiniteTroops: s.defCityLevels === undefined,
    },
  });
  const { game, attacker, defender, config } = w;
  const posts = buildForts(w, fortPositions(m, s.fort));
  const cover = coverage(w);
  placeCities(w, s.cityLevels);
  if (s.defCityLevels !== undefined) {
    const spots: Point[] = [];
    for (let y = MARGIN + 10; y < MARGIN + m.rows - 5; y += 20) {
      for (let x = m.frontX + 8; x < m.frontX + m.defenderCols - 5; x += 20) {
        spots.push({ x, y });
      }
    }
    const n = Math.min(spots.length, Math.ceil(s.defCityLevels / 50));
    const cities = spots
      .slice(0, n)
      .map((p) => defender.buildUnit(UnitType.City, game.ref(p.x, p.y), {}));
    for (
      let i = 0, left = s.defCityLevels - n;
      left > 0;
      i = (i + 1) % n, left--
    ) {
      cities[i].increaseLevel();
    }
  }
  const sams = placeSams(w, s.sams, true);
  const silos = placeSilos(
    w,
    s.nukes.map((n) => n.silo),
  );
  // increaseLevel() adds one cooling slot (90 ticks) per level after a 45-tick
  // upgrade ramp, so a SAM only has its full magazine ~135 ticks later: warm up
  // before anything is fired (the earlier labs used >=100 as well).
  for (let i = 0; i < (s.warmup ?? 150); i++) {
    game.executeNextTick();
    attacker.removeGold(attacker.gold());
  }
  attacker.setTroops(s.nationTroops);
  defender.setTroops(s.defTroops);
  if (s.frozenNationRegen) config.frozenRegen.add("attacker");
  if (s.tinyBlast) config.tinyBlast = true;
  const nationCap = config.maxTroops(attacker);
  const defTiles0 = defender.numTilesOwned();
  const nationTilesStart = attacker.numTilesOwned();
  nlog(
    `[scenario] ${s.label} 就緒 nation上限=${fmtN(nationCap)} 防守上限=${fmtN(config.maxTroops(defender))} 堡壘=${posts} 涵蓋=${(cover * 100).toFixed(1)}% 防守格=${defTiles0} nation格=${nationTilesStart} 飛彈井=${silos.length} SAM單位=${sams.length}`,
  );

  if (s.forcedAttack !== undefined) {
    game.addExecution(
      new AttackExecution(s.forcedAttack, attacker, defender.id()),
    );
  } else {
    game.addExecution(
      new NationExecution(
        "fortress-nuke",
        new Nation(
          undefined,
          new PlayerInfo("attacker", PlayerType.Nation, null, "attacker"),
        ),
      ),
    );
  }

  const fates: NukeFate[] = s.nukes.map((plan) => ({
    plan,
    launched: false,
    fate: "pending",
    endTick: null,
  }));
  const tracked = new Map<number, { f: NukeFate; unit: Unit }>();
  const claimed = new Set<NukeFate>();
  const samMissileIds = new Set<number>();
  const samples: NukeSample[] = [];
  const attackTroops = () =>
    attacker
      .outgoingAttacks()
      .filter((a) => a.target() === defender)
      .reduce((sum, a) => sum + a.troops(), 0);
  const sample = (tick: number) => {
    samples.push({
      tick,
      pool: attacker.troops(),
      attack: attackTroops(),
      defTroops: defender.troops(),
      defTiles: defender.isAlive() ? defender.numTilesOwned() : 0,
      nationTiles: attacker.numTilesOwned(),
      landed: fates.filter((f) => f.fate === "landed").length,
      intercepted: fates.filter((f) => f.fate === "intercepted").length,
    });
  };
  game.executeNextTick();
  const poolStart = attacker.troops();
  let tick = 0;
  let tickTo50: number | null = null;
  let tickTo100: number | null = null;
  let endReason = "tick 上限";
  let attackPeak = attackTroops();
  let idle = 0;
  let everAttacked = attackPeak > 0;
  sample(0);
  while (tick < s.maxTicks) {
    for (const f of fates) {
      if (!f.launched && f.plan.tick <= tick) {
        f.launched = true;
        game.addExecution(
          new NukeExecution(
            f.plan.type,
            defender,
            game.ref(f.plan.tx, f.plan.ty),
            game.ref(f.plan.silo.x, f.plan.silo.y),
          ),
        );
      }
    }
    game.executeNextTick();
    tick++;
    attacker.removeGold(attacker.gold());
    for (const u of game.units(UnitType.AtomBomb, UnitType.HydrogenBomb)) {
      if (tracked.has(u.id())) continue;
      const tt = u.targetTile();
      const f = fates.find(
        (x) =>
          x.launched &&
          !claimed.has(x) &&
          tt === game.ref(x.plan.tx, x.plan.ty) &&
          u.type() === x.plan.type,
      );
      if (f) {
        claimed.add(f);
        tracked.set(u.id(), { f, unit: u });
      }
    }
    for (const [id, { f, unit }] of tracked) {
      if (unit.isActive()) continue;
      f.fate = unit.reachedTarget() ? "landed" : "intercepted";
      f.endTick = tick;
      tracked.delete(id);
    }
    for (const u of game.units(UnitType.SAMMissile)) samMissileIds.add(u.id());
    const atk = attackTroops();
    if (atk > 0) everAttacked = true;
    attackPeak = Math.max(attackPeak, atk);
    const lost =
      defTiles0 - (defender.isAlive() ? defender.numTilesOwned() : 0);
    if (tickTo50 === null && lost >= defTiles0 * 0.5) tickTo50 = tick;
    if (tickTo100 === null && lost >= defTiles0 * 0.999) tickTo100 = tick;
    if (tick % s.sampleEvery === 0) sample(tick);
    if (!defender.isAlive()) {
      endReason = "防守方被消滅";
      break;
    }
    idle = atk > 0 ? 0 : idle + 1;
    const pending = fates.some((f) => !f.launched) || tracked.size > 0;
    if (everAttacked && idle >= 100 && !pending) {
      endReason = "進攻結束";
      break;
    }
  }
  sample(tick);
  const defTilesEnd = defender.isAlive() ? defender.numTilesOwned() : 0;
  const atoms = s.nukes.filter((n) => n.type === UnitType.AtomBomb).length;
  const hydros = s.nukes.length - atoms;
  const res: NukeScenarioResult = {
    label: s.label,
    samCount: s.sams.length,
    nukeCount: s.nukes.length,
    fates,
    landed: fates.filter((f) => f.fate === "landed").length,
    intercepted: fates.filter((f) => f.fate === "intercepted").length,
    samMissiles: samMissileIds.size,
    samsAliveEnd: sams.filter((u) => u.isActive()).length,
    nationCap,
    poolStart,
    attackPeak,
    attackEnd: attackTroops(),
    nationTilesStart,
    nationTilesEnd: attacker.numTilesOwned(),
    defTiles0,
    lostTiles: defTiles0 - defTilesEnd,
    lostFrac: (defTiles0 - defTilesEnd) / defTiles0,
    tickTo50,
    tickTo100,
    defTroopsEnd: defender.troops(),
    endReason,
    ticks: tick,
    samples,
    cost: {
      atoms,
      hydrogens: hydros,
      siloLevels: silos.length,
      gold:
        atoms * PRICE.atom +
        hydros * PRICE.hydrogen +
        silos.length * PRICE.silo,
    },
    elapsedMs: performance.now() - t0,
  };
  nlog(
    `[scenario] ${s.label} 結束(${endReason}) tick=${tick} 核彈 落地${res.landed}/攔截${res.intercepted}/共${s.nukes.length} SAM飛彈=${res.samMissiles} 失地=${(res.lostFrac * 100).toFixed(1)}% 50%@${tickTo50} 100%@${tickTo100} 進攻峰值=${fmtN(attackPeak)} 進攻末=${fmtN(res.attackEnd)} nation格 ${nationTilesStart}→${res.nationTilesEnd} 花費=${fmtN(res.cost.gold)}金幣 耗時=${(res.elapsedMs / 1000).toFixed(1)}s`,
  );
  return res;
}
