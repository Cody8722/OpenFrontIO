// Fortress siege lab: one big attack against a defender with and without
// DefensePosts, run on the real engine (EngineConfig, not TestConfig: that one
// replaces attackLogic with a constant). Test-only; nothing here touches the
// engine. The log is opened before anything is built so a crash still leaves
// the parameters on disk.
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import type { GameConfig } from "@openfront/engine-api/Schemas";
import { genTerrainFromBin } from "@openfront/engine-lib/game/TerrainMapLoader";
import {
  AttackLogicInput,
  AttackLogicResult,
  EngineConfig,
} from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { createGame } from "@openfront/engine/game/GameImpl";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import zlib from "zlib";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DATA_DIR = path.join(ROOT, ".fortress-siege-data");
const LOG_FILE = path.join(DATA_DIR, "siege.log");

const LAND = 0x80;
const SHORE = 0x40;
const OCEAN = 0x20;
const PLAINS_MAGNITUDE = 5;
const MARGIN = 10;

// ------------------------------------------------------------------- log

export function logLine(line: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${line}\n`);
  console.log(line);
}

// ---------------------------------------------------------------- config

/** Real rules; the only differences are the knobs this lab needs. */
export class SiegeConfig extends EngineConfig {
  /** Players whose troops do not regenerate (the formula assumes none). */
  readonly frozenRegen = new Set<string>();

  troopIncreaseRate(player: Parameters<EngineConfig["troopIncreaseRate"]>[0]) {
    if (this.frozenRegen.has(player.id())) return 0;
    return super.troopIncreaseRate(player);
  }

  spawnImmunityDuration(): number {
    return 0;
  }

  /** attackLogic runs once per conquered tile: count how many had a post. */
  readonly tileStats = { tiles: 0, withPost: 0 };

  attackLogic(input: AttackLogicInput): AttackLogicResult {
    if (input.defender !== null) {
      this.tileStats.tiles++;
      if (input.defenderHasDefensePost) this.tileStats.withPost++;
    }
    return super.attackLogic(input);
  }
}

function gameConfigFor(): GameConfig {
  return {
    gameMap: GameMapType.Asia,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Medium,
    nations: "disabled",
    donateGold: false,
    donateTroops: false,
    bots: 0,
    infiniteGold: true,
    // Lifts the human troop cap to 1e9; without it 1e5 tiles cap at ~2.1e6.
    infiniteTroops: true,
    instantBuild: true,
    randomSpawn: false,
  };
}

// --------------------------------------------------------------- terrain

export interface SiegeMap {
  w: number;
  h: number;
  attackerCols: number;
  defenderCols: number;
  rows: number;
  /** First column of the defender; the front is the line x = frontX. */
  frontX: number;
  map: Uint8Array;
  mini: Uint8Array;
}

function terrainBytes(
  w: number,
  h: number,
  isLand: (x: number, y: number) => boolean,
) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const land = isLand(x, y);
      const differs = (nx: number, ny: number) =>
        nx >= 0 && ny >= 0 && nx < w && ny < h && isLand(nx, ny) !== land;
      const shore =
        differs(x - 1, y) ||
        differs(x + 1, y) ||
        differs(x, y - 1) ||
        differs(x, y + 1);
      out[y * w + x] = land
        ? LAND | (shore ? SHORE : 0) | PLAINS_MAGNITUDE
        : OCEAN | (shore ? SHORE : 0) | 1;
    }
  }
  return out;
}

/** All-plains land: attacker block on the left, defender block on the right. */
export function siegeMap(
  attackerCols: number,
  defenderCols: number,
  rows: number,
): SiegeMap {
  const w = 2 * Math.ceil((attackerCols + defenderCols + 2 * MARGIN) / 2);
  const h = 2 * Math.ceil((rows + 2 * MARGIN) / 2);
  const land = (x: number, y: number) =>
    x >= MARGIN &&
    x < MARGIN + attackerCols + defenderCols &&
    y >= MARGIN &&
    y < MARGIN + rows;
  const map = terrainBytes(w, h, land);
  const mini = terrainBytes(w >> 1, h >> 1, (x, y) => land(2 * x, 2 * y));
  return {
    w,
    h,
    attackerCols,
    defenderCols,
    rows,
    frontX: MARGIN + attackerCols,
    map,
    mini,
  };
}

function metaOf(bytes: Uint8Array, w: number, h: number) {
  let land = 0;
  for (const b of bytes) if ((b & LAND) !== 0) land++;
  return { width: w, height: h, num_land_tiles: land };
}

// ----------------------------------------------------------------- world

export interface SiegeWorld {
  game: Game;
  attacker: Player;
  defender: Player;
  config: SiegeConfig;
  map: SiegeMap;
}

export async function siegeWorld(m: SiegeMap): Promise<SiegeWorld> {
  console.debug = () => {};
  const gameMap = await genTerrainFromBin(metaOf(m.map, m.w, m.h), m.map);
  const mini = await genTerrainFromBin(
    metaOf(m.mini, m.w >> 1, m.h >> 1),
    m.mini,
  );
  const config = new SiegeConfig(gameConfigFor(), false);
  const humans = [
    new PlayerInfo("attacker", PlayerType.Human, "c1", "attacker"),
    new PlayerInfo("defender", PlayerType.Human, "c2", "defender"),
  ];
  const game = createGame(humans, [], gameMap, mini, config);
  game.endSpawnPhase();
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  for (let y = MARGIN; y < MARGIN + m.rows; y++) {
    for (let x = MARGIN; x < m.frontX; x++) attacker.conquer(game.ref(x, y));
    for (let x = m.frontX; x < m.frontX + m.defenderCols; x++) {
      defender.conquer(game.ref(x, y));
    }
  }
  // SpawnExecution adds this on a real spawn; it is what regenerates troops
  // and deletes a fortress once its tile changes hands.
  game.addExecution(new PlayerExecution(attacker));
  game.addExecution(new PlayerExecution(defender));
  return { game, attacker, defender, config, map: m };
}

// ------------------------------------------------------------ fortresses

export type FortPlan = "none" | "full" | "band";

export interface Point {
  x: number;
  y: number;
}

/**
 * "full": square lattice with spacing 42 (= 30 * sqrt 2), the widest square
 * lattice whose radius-30 circles still cover every tile.
 * "band": the layout in the request: rows 60 apart, `layers` columns 60 apart
 * starting 30 tiles behind the front.
 */
export function fortPositions(
  m: SiegeMap,
  plan: FortPlan,
  layers = 3,
): Point[] {
  if (plan === "none") return [];
  const out: Point[] = [];
  const y0 = MARGIN;
  const x0 = m.frontX;
  if (plan === "full") {
    const s = 42;
    for (let y = y0 + 21; y < y0 + m.rows; y += s) {
      for (let x = x0 + 21; x < x0 + m.defenderCols; x += s) out.push({ x, y });
    }
    return out;
  }
  for (let k = 0; k < layers; k++) {
    for (let y = y0 + 30; y < y0 + m.rows; y += 60) {
      out.push({ x: x0 + 30 + 60 * k, y });
    }
  }
  return out;
}

/** Build through the real construction path; returns how many stood. */
export function buildForts(w: SiegeWorld, pts: Point[]): number {
  for (const p of pts) {
    w.game.addExecution(
      new ConstructionExecution(
        w.defender,
        UnitType.DefensePost,
        w.game.ref(p.x, p.y),
      ),
    );
  }
  for (let i = 0; i < 4; i++) w.game.executeNextTick();
  return w.defender
    .units(UnitType.DefensePost)
    .filter((u) => !u.isUnderConstruction()).length;
}

/** Share of the defender's tiles that the engine itself reports as covered. */
export function coverage(w: SiegeWorld): number {
  const range = w.config.defensePostRange();
  let covered = 0;
  let total = 0;
  for (const t of w.defender.tiles()) {
    total++;
    if (w.game.hasUnitNearby(t, range, UnitType.DefensePost, w.defender.id()))
      covered++;
  }
  return total === 0 ? 0 : covered / total;
}

// ---------------------------------------------------------------- frames

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(
      raw,
      y * (w * 3 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const COLORS = {
  sea: [28, 40, 56],
  attacker: [60, 120, 200],
  defender: [200, 70, 70],
  fort: [255, 215, 0],
};

/** One pixel per tile; forts are 5x5 gold squares. Writes the PNG file. */
export function renderFrame(w: SiegeWorld, file: string): void {
  const { map } = w;
  const px = new Uint8Array(map.w * map.h * 3);
  const gm = w.game.map();
  const aId = w.attacker.smallID();
  const dId = w.defender.smallID();
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const ref = w.game.ref(x, y);
      const o = gm.ownerID(ref);
      const c = !gm.isLand(ref)
        ? COLORS.sea
        : o === aId
          ? COLORS.attacker
          : o === dId
            ? COLORS.defender
            : COLORS.sea;
      const i = (y * map.w + x) * 3;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
    }
  }
  for (const u of w.defender.units(UnitType.DefensePost)) {
    const cx = w.game.x(u.tile());
    const cy = w.game.y(u.tile());
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
        const i = (y * map.w + x) * 3;
        px[i] = COLORS.fort[0];
        px[i + 1] = COLORS.fort[1];
        px[i + 2] = COLORS.fort[2];
      }
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(map.w, map.h, px));
}

// ------------------------------------------------------------------ runs

export interface SiegeSpec {
  label: string;
  /** Troops the attack should carry; the pool is 5x (the engine commits 1/5). */
  commit: number;
  /** Defender troops as a multiple of `commit`. */
  defMult: number;
  fort: FortPlan;
  layers?: number;
  defRegen: boolean;
  attackerCols: number;
  defenderCols: number;
  rows: number;
  maxTicks: number;
  sampleEvery: number;
  /** Ticks between map frames. */
  frameEvery: number;
}

export interface Sample {
  tick: number;
  attack: number;
  defTroops: number;
  defTiles: number;
  atkTiles: number;
  posts: number;
  /** Tiles conquered so far, and how many of them stood under a post. */
  conquered: number;
  conqueredWithPost: number;
}

export interface SiegeResult {
  spec: SiegeSpec;
  committed: number;
  attackerPool0: number;
  defTroops0: number;
  defTiles0: number;
  atkTiles0: number;
  posts0: number;
  coverage: number;
  /** Share of conquered tiles that had a post in range when taken. */
  effCoverage: number;
  ticks: number;
  endReason: string;
  defTilesEnd: number;
  defTroopsEnd: number;
  atkTilesEnd: number;
  postsEnd: number;
  attackLeft: number;
  lostTiles: number;
  lostFrac: number;
  atkLoss: number;
  lossPerTile: number;
  defTroopsLost: number;
  samples: Sample[];
  frames: { tick: number; file: string }[];
  elapsedMs: number;
}

const fmt = (n: number) =>
  Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n.toFixed(0);

export async function runSiege(spec: SiegeSpec): Promise<SiegeResult> {
  const t0 = performance.now();
  logLine(
    `[siege] ${spec.label} 開始 commit=${fmt(spec.commit)} defMult=${spec.defMult} fort=${spec.fort} defRegen=${spec.defRegen} map=${spec.attackerCols}+${spec.defenderCols}x${spec.rows}`,
  );
  const m = siegeMap(spec.attackerCols, spec.defenderCols, spec.rows);
  const w = await siegeWorld(m);
  const { game, attacker, defender } = w;
  if (!spec.defRegen) w.config.frozenRegen.add("defender");
  w.config.frozenRegen.add("attacker");

  const posts0 = buildForts(w, fortPositions(m, spec.fort, spec.layers));
  const cover = coverage(w);
  attacker.setTroops(spec.commit * 5);
  defender.setTroops(spec.commit * spec.defMult);
  const attackerPool0 = attacker.troops();
  const defTroops0 = defender.troops();
  const defTiles0 = defender.numTilesOwned();
  const atkTiles0 = attacker.numTilesOwned();
  logLine(
    `[siege] ${spec.label} 就緒 防守格=${defTiles0} 進攻格=${atkTiles0} 堡壘=${posts0} 涵蓋=${(cover * 100).toFixed(1)}% 防守兵=${fmt(defTroops0)} 進攻池=${fmt(attackerPool0)}`,
  );

  const dir = path.join(DATA_DIR, spec.label.replace(/[^\w.-]+/g, "_"));
  const frames: { tick: number; file: string }[] = [];
  const snap = (tick: number) => {
    const file = path.join(dir, `frame-${String(tick).padStart(5, "0")}.png`);
    renderFrame(w, file);
    frames.push({ tick, file });
  };
  snap(0);

  game.addExecution(new AttackExecution(null, attacker, defender.id()));
  game.executeNextTick();
  const attack = attacker
    .outgoingAttacks()
    .find((a) => a.target() === defender);
  if (attack === undefined) {
    throw new Error(`${spec.label}: the attack did not start`);
  }
  const committed = attack.troops();
  logLine(
    `[siege] ${spec.label} 實際投入=${fmt(committed)} (池 ${fmt(attackerPool0)} 的 1/5)`,
  );

  const samples: Sample[] = [];
  const sample = (tick: number) => {
    const s = {
      tick,
      attack: attack.troops(),
      defTroops: defender.troops(),
      defTiles: defender.numTilesOwned(),
      atkTiles: attacker.numTilesOwned(),
      posts: defender.units(UnitType.DefensePost).length,
      conquered: w.config.tileStats.tiles,
      conqueredWithPost: w.config.tileStats.withPost,
    };
    samples.push(s);
    logLine(
      `[siege] ${spec.label} t=${tick} 攻擊兵=${fmt(s.attack)} 防守兵=${fmt(s.defTroops)} 防守格=${s.defTiles} 堡壘=${s.posts} 已奪=${s.conquered} 其中有堡壘涵蓋=${s.conqueredWithPost}`,
    );
  };
  sample(1);

  let lastAttack = attack.troops();
  let tick = 1;
  let endReason = "tick 上限";
  const frameEvery = Math.max(1, spec.frameEvery);
  while (tick < spec.maxTicks) {
    game.executeNextTick();
    tick++;
    if (attack.isActive()) lastAttack = attack.troops();
    if (tick % spec.sampleEvery === 0) sample(tick);
    if (tick % frameEvery === 0) snap(tick);
    if (!defender.isAlive()) {
      endReason = "防守方被消滅";
      break;
    }
    if (!attack.isActive()) {
      endReason = lastAttack < 1 ? "進攻兵力耗盡" : "進攻結束(無可奪格或撤退)";
      break;
    }
  }
  sample(tick);
  snap(tick);

  const defTilesEnd = defender.isAlive() ? defender.numTilesOwned() : 0;
  const lostTiles = defTiles0 - defTilesEnd;
  const attackLeft = Math.max(0, lastAttack);
  const atkLoss = committed - attackLeft;
  const res: SiegeResult = {
    spec,
    committed,
    attackerPool0,
    defTroops0,
    defTiles0,
    atkTiles0,
    posts0,
    coverage: cover,
    effCoverage:
      w.config.tileStats.tiles > 0
        ? w.config.tileStats.withPost / w.config.tileStats.tiles
        : 0,
    ticks: tick,
    endReason,
    defTilesEnd,
    defTroopsEnd: defender.troops(),
    atkTilesEnd: attacker.numTilesOwned(),
    postsEnd: defender.units(UnitType.DefensePost).length,
    attackLeft,
    lostTiles,
    lostFrac: lostTiles / defTiles0,
    atkLoss,
    lossPerTile: lostTiles > 0 ? atkLoss / lostTiles : NaN,
    defTroopsLost: defTroops0 - defender.troops(),
    samples,
    frames,
    elapsedMs: performance.now() - t0,
  };
  logLine(
    `[siege] ${spec.label} 結束(${endReason}) tick=${tick} 被奪格實際有堡壘涵蓋=${(res.effCoverage * 100).toFixed(1)}% 失地=${lostTiles}/${defTiles0}(${(res.lostFrac * 100).toFixed(1)}%) 進攻損失=${fmt(atkLoss)} 每格=${fmt(res.lossPerTile)} 防守兵 ${fmt(defTroops0)}→${fmt(res.defTroopsEnd)} 耗時=${(res.elapsedMs / 1000).toFixed(1)}s`,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(res));
  return res;
}

// ---------------------------------------------------------------- formula

export interface ModelResult {
  /** Constant first-tile loss (the figure quoted as 336 / 1678). */
  firstTileLoss: number;
  /** Tiles taken if that loss never changed. */
  staticTiles: number;
  /** Tile-by-tile with the real attackLogic and a shrinking attack/defender. */
  tiles: number;
  frac: number;
  ticks: number;
  attackLeft: number;
}

/**
 * The formula on the same numbers, no map: feeds the engine's own attackLogic
 * one plains tile at a time, updating attack troops, defender troops and both
 * territory sizes as the real loop does (defender loses troops/numTiles per
 * tile; no regeneration). `covered` is the share of tiles under a post.
 */
export function modelSiege(
  config: SiegeConfig,
  commit: number,
  defTroops: number,
  defTiles: number,
  atkTiles: number,
  covered: number,
  borderSize: number,
): ModelResult {
  const input = (
    a: number,
    d: number,
    td: number,
    ta: number,
    post: boolean,
  ): AttackLogicInput => ({
    terrain: TerrainType.Plains,
    attackTroops: a,
    attacker: { type: PlayerType.Human, numTiles: ta },
    defender: {
      type: PlayerType.Human,
      numTiles: td,
      troops: d,
      isTraitor: false,
      isDisconnectedTeammate: false,
    },
    defenderHasDefensePost: post,
    falloutRatio: null,
    borderSize,
  });
  const first = config.attackLogic(
    input(commit, defTroops, defTiles, atkTiles, covered >= 0.5),
  );
  let a = commit;
  let d = defTroops;
  let td = defTiles;
  let ta = atkTiles;
  let budget = 0;
  let taken = 0;
  // Spread the covered share evenly: tile i is covered when the running
  // count of covered tiles advances.
  let coveredSoFar = 0;
  while (a >= 1 && td >= 100) {
    const post = Math.floor((taken + 1) * covered) > coveredSoFar;
    if (post) coveredSoFar++;
    const r = config.attackLogic(input(a, d, td, ta, post));
    budget += r.tickFraction;
    a -= r.attackerTroopLoss;
    d = Math.max(0, d - r.defenderTroopLoss);
    td--;
    ta++;
    taken++;
  }
  return {
    firstTileLoss: first.attackerTroopLoss,
    staticTiles: Math.min(defTiles, commit / first.attackerTroopLoss),
    tiles: taken,
    frac: taken / defTiles,
    ticks: budget,
    attackLeft: Math.max(0, a),
  };
}

// ----------------------------------------------------------------- report

const PREDICTED: Record<string, number> = {
  "1-none": 1.0,
  "1-full": 0.42,
  "2-none": 0.77,
  "2-full": 0.15,
  "4-none": 0.39,
  "4-full": 0.08,
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function loadResults(): SiegeResult[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .map((d) => path.join(DATA_DIR, d, "result.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as SiegeResult)
    .filter((r) => r.spec.commit >= 1e7)
    .sort((a, b) => a.spec.label.localeCompare(b.spec.label));
}

function frameCaption(r: SiegeResult, tick: number): string {
  const s =
    [...r.samples].reverse().find((x) => x.tick <= tick) ?? r.samples[0];
  return `t=${(tick / 10).toFixed(0)}s · 攻擊兵 ${fmt(s.attack)} · 防守兵 ${fmt(s.defTroops)} · 防守格 ${s.defTiles} · 堡壘 ${s.posts}`;
}

/** One self-contained HTML page: numbers table plus a frame strip per run. */
export function buildSiegeReport(file: string): string {
  const runs = loadResults();
  const cfg = new SiegeConfig({} as never, false);
  const rows = runs
    .map((r) => {
      const s = r.spec;
      const key = `${s.defMult}-${s.fort}`;
      const m100 = modelSiege(
        cfg,
        r.committed,
        r.defTroops0,
        r.defTiles0,
        r.atkTiles0,
        r.coverage,
        s.rows + 2,
      );
      const mEff = modelSiege(
        cfg,
        r.committed,
        r.defTroops0,
        r.defTiles0,
        r.atkTiles0,
        r.effCoverage,
        s.rows + 2,
      );
      const pred = s.defRegen || s.fort === "band" ? undefined : PREDICTED[key];
      return `<tr><td>${s.label}</td><td>${s.defMult}x</td><td>${s.fort}${s.defRegen ? " +補充" : ""}</td>
<td>${pct(r.coverage)}</td><td>${pct(r.effCoverage)}</td>
<td><b>${pct(r.lostFrac)}</b></td><td>${pred === undefined ? "–" : pct(pred)}</td>
<td>${pct(m100.frac)}</td><td>${pct(mEff.frac)}</td>
<td>${fmt(r.lossPerTile)}</td><td>${fmt(m100.firstTileLoss)}</td>
<td>${fmt(r.defTroops0)}→${fmt(r.defTroopsEnd)}</td><td>${r.ticks}</td><td>${r.endReason}</td></tr>`;
    })
    .join("\n");
  const strips = runs
    .map((r) => {
      const imgs = r.frames
        .map((f) => {
          const b64 = fs.readFileSync(f.file).toString("base64");
          return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${frameCaption(r, f.tick)}</figcaption></figure>`;
        })
        .join("\n");
      return `<section><h3>${r.spec.label} — 失地 ${pct(r.lostFrac)}(${r.endReason})</h3><div class="strip">${imgs}</div></section>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>堡壘攻防實測</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#1c2733;--mut:#5b6773;--line:#d9dee3;--acc:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--fg:#e6eaee;--mut:#9aa5b0;--line:#2b333b;--acc:#ff7a6b}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
h1{font-size:20px}h3{font-size:15px;margin:20px 0 6px}.note{color:var(--mut);max-width:80ch}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border:1px solid var(--line);padding:4px 6px;text-align:right}
th{background:var(--line)}td:first-child,td:nth-child(3),td:last-child{text-align:left}
.strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}
figure{margin:0}img{width:100%;image-rendering:pixelated;border:1px solid var(--line)}
figcaption{font-size:11.5px;color:var(--mut)}</style></head><body>
<h1>堡壘 + 高兵力 vs 一波 1 億兵進攻</h1>
<p class="note">真實引擎的無頭模擬(EngineConfig + AttackExecution + DefensePost),不是瀏覽器操作介面。平地,防守 10 萬格、進攻方 30 萬格,防守方兵力不補充(「+補充」列例外)。畫面:藍=進攻方、紅=防守方、金=堡壘。</p>
<table><thead><tr><th>條件</th><th>防守兵力</th><th>堡壘</th><th>起始涵蓋</th><th>被奪格實際涵蓋</th><th>實測失地</th><th>你的推算</th><th>積分(涵蓋100%)</th><th>積分(用實測涵蓋)</th><th>實測每格損失</th><th>首格損失</th><th>防守兵力變化</th><th>tick</th><th>結束原因</th></tr></thead>
<tbody>${rows}</tbody></table>
${strips}</body></html>`;
  fs.writeFileSync(file, html);
  return file;
}
