// The fresh evaluation seeds (18 map x opening strata x 3) and the reproducible
// split of a game's nations into two halves, shared by the evidence runs.
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import type { TraceSpec } from "./NationTrace";

const MAPS: { map: string; nations: number }[] = [
  { map: "world", nations: 61 },
  { map: "real:asia", nations: 25 },
  { map: "real:britannia", nations: 20 },
  { map: "real:caribbean", nations: 34 },
  { map: "real:baltics", nations: 35 },
  { map: "real:eastasia", nations: 22 },
  { map: "real:africa", nations: 44 },
  { map: "real:europe", nations: 52 },
  { map: "real:balkans", nations: 23 },
];

export type EvalSpec = TraceSpec & { opening: string };

/** 18 strata x 3 fresh seeds (full, half, full nation count), 6000 ticks, Hard. */
export function evalSpecs(): EvalSpec[] {
  const out: EvalSpec[] = [];
  for (const { map, nations } of MAPS) {
    for (const opening of ["normal", "rich"]) {
      [nations, Math.round(nations / 2), nations].forEach((n, i) => {
        const gameID = `${map.replace("real:", "")}-${opening}-n${n}-s${10 + i}`;
        out.push({
          label: gameID,
          gameID,
          map,
          difficulty: Difficulty.Hard,
          nations: n,
          ticks: 6000,
          opening,
          ...(opening === "rich"
            ? { startingGold: 1_000_000_000, goldMultiplier: 10 }
            : {}),
        });
      });
    }
  }
  return out;
}

/** FNV-1a over the whole string plus a finalizer, so every character mixes in. */
function mix(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * One half of a game's nations by hash(id + gameID); `swap` gives the other
 * half. The first half has the extra nation when the count is odd.
 */
export function halfOf(
  ids: string[],
  gameID: string,
  swap: boolean,
): Set<string> {
  const ranked = [...ids].sort(
    (a, b) => mix(`${a}|${gameID}`) - mix(`${b}|${gameID}`) || (a < b ? -1 : 1),
  );
  const first = new Set(ranked.slice(0, Math.ceil(ids.length / 2)));
  return swap ? new Set(ids.filter((i) => !first.has(i))) : first;
}
