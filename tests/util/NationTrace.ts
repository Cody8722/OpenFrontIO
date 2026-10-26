// Tick-level fingerprint of a nation-only game, for proving that a change to
// the nation AI leaves behaviour untouched: same seed -> same chain hash.
import {
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { MapManifest } from "@openfront/engine-api/game/MapFiles";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import type { NationTimingConfig } from "@openfront/engine/execution/nation/NationTiming";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import type { AttackPolicy } from "@openfront/engine/execution/utils/AttackPolicy";
import { Game } from "@openfront/engine/game/Game";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setup } from "./Setup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TraceSpec {
  label: string;
  gameID: string;
  difficulty: Difficulty;
  nations: number; // first N manifest nations
  // test map (default "world") or a real game map under resources/maps
  map?: string;
  ticks: number; // ticks after the spawn phase
  startingGold?: number;
  goldMultiplier?: number;
}

export interface TraceResult {
  label: string;
  ticks: number;
  // FNV-1a over every tick's (troops, tiles) of every player, in player order
  chain: string;
  // chain value every `checkpointEvery` ticks, to localise a divergence
  checkpoints: string[];
  attacksStarted: number;
  finalTroops: number;
  finalTiles: number;
}

export const CHECKPOINT_EVERY = 300;

function fnv(h: number, v: number): number {
  // v is an integer < 2^53; fold it as two 32-bit halves
  const lo = v >>> 0;
  const hi = Math.floor(v / 4294967296) >>> 0;
  h = Math.imul(h ^ lo, 16777619) >>> 0;
  h = Math.imul(h ^ hi, 16777619) >>> 0;
  return h;
}

// Real game maps are named as a path from tests/testdata/maps (what setup() joins)
function mapRef(map: string): { setupName: string; manifest: string } {
  const real = map.startsWith("real:");
  const name = real ? map.slice(5) : map;
  return real
    ? {
        setupName: `../../../resources/maps/${name}`,
        manifest: path.join(
          __dirname,
          `../../resources/maps/${name}/manifest.json`,
        ),
      }
    : {
        setupName: name,
        manifest: path.join(
          __dirname,
          `../testdata/maps/${name}/manifest.json`,
        ),
      };
}

export function loadWorldNations(count: number, map = "world"): Nation[] {
  const manifest = JSON.parse(
    fs.readFileSync(mapRef(map).manifest, "utf8"),
  ) as MapManifest;
  const placed = manifest.nations.flatMap((n) =>
    n.coordinates === undefined ? [] : [{ name: n.name, at: n.coordinates }],
  );
  return placed
    .slice(0, count)
    .map(
      (n, i) =>
        new Nation(
          new Cell(n.at[0], n.at[1]),
          new PlayerInfo(n.name, PlayerType.Nation, null, `nation_${i}`),
        ),
    );
}

export async function traceWorld(
  spec: TraceSpec,
  onTick?: (game: Game, tick: number) => void,
  configClass: typeof EngineConfig = EngineConfig,
  policy?: AttackPolicy | ((nation: Nation, game: Game) => AttackPolicy),
  timing?:
    | NationTimingConfig
    | ((nation: Nation) => NationTimingConfig | undefined),
): Promise<{
  result: TraceResult;
  game: Game;
  executions: NationExecution[];
}> {
  const nations = loadWorldNations(spec.nations, spec.map);
  const game = await setup(
    mapRef(spec.map ?? "world").setupName,
    {
      difficulty: spec.difficulty,
      startingGold: spec.startingGold,
      goldMultiplier: spec.goldMultiplier,
    },
    [],
    undefined,
    configClass,
    false,
    nations,
  );
  const executions: NationExecution[] = [];
  for (const n of game.nations()) {
    const exec = new NationExecution(
      spec.gameID,
      n,
      typeof policy === "function" ? policy(n, game) : policy,
      typeof timing === "function" ? timing(n) : timing,
    );
    executions.push(exec);
    game.addExecution(exec);
  }
  // The spawn phase never ends by itself without humans: let the nations
  // place themselves, then end it by hand (as the snapshot tests do).
  for (let i = 0; i < 15; i++) game.executeNextTick();
  game.endSpawnPhase();

  let h = 2166136261;
  const checkpoints: string[] = [];
  let attacksStarted = 0;
  const seen = new Set<unknown>();
  for (let t = 0; t < spec.ticks; t++) {
    game.executeNextTick();
    for (const p of game.players()) {
      h = fnv(h, Number(p.troops()));
      h = fnv(h, p.numTilesOwned());
      for (const a of p.outgoingAttacks()) {
        if (!seen.has(a)) {
          seen.add(a);
          attacksStarted++;
        }
      }
    }
    if ((t + 1) % CHECKPOINT_EVERY === 0) checkpoints.push(h.toString(16));
    onTick?.(game, t);
  }
  let finalTroops = 0;
  let finalTiles = 0;
  for (const p of game.players()) {
    finalTroops += Number(p.troops());
    finalTiles += p.numTilesOwned();
  }
  return {
    result: {
      label: spec.label,
      ticks: spec.ticks,
      chain: h.toString(16),
      checkpoints,
      attacksStarted,
      finalTroops,
      finalTiles,
    },
    game,
    executions,
  };
}

/** A nation's attack lattice (private to the engine), for the logs. */
export function schedule(exec: NationExecution): {
  attackRate: number;
  attackTick: number;
} {
  const e = exec as unknown as { attackRate: number; attackTick: number };
  return { attackRate: e.attackRate, attackTick: e.attackTick };
}
