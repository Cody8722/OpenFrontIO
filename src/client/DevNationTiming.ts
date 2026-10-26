import { GameType } from "@openfront/engine-api/game/GameTypes";
import { GameEnv } from "@openfront/shared/configuration/Env";

/**
 * Dev switch for watching jittered nation timing in a real game:
 * `?nationTiming=0.5` on the page URL. Returns the spread to hand to the
 * engine, or undefined when the request does not apply:
 *  - only single-player games (a multiplayer room is lockstep: every client
 *    must run the same thing, so the parameter is ignored there);
 *  - only outside production (`env` is read lazily, after the cheap checks);
 *  - only a number in [0, 1).
 */
export function nationTimingRequest(
  search: string,
  gameType: GameType,
  env: () => GameEnv,
): number | undefined {
  if (gameType !== GameType.Singleplayer) return undefined;
  const raw = new URLSearchParams(search).get("nationTiming");
  if (raw === null || raw.trim() === "") return undefined;
  const spread = Number(raw);
  if (!Number.isFinite(spread) || spread < 0 || spread >= 1) return undefined;
  return env() === GameEnv.Dev ? spread : undefined;
}
