import { GameType } from "@openfront/engine-api/game/GameTypes";
import { GameEnv } from "@openfront/shared/configuration/Env";

// The page's query string as it was when the document LOADED. By the time a
// game starts the address bar no longer has it (a single-player start does
// `history.replaceState(null, "", "/")`, a joined game becomes `/w0/game/<id>`),
// and WorkerClient is only loaded then, with the game client chunk, so it
// cannot take the value itself. Main.bootstrap takes it first (see PagePin.ts
// for the same pattern). Only kept on a dev build, and only when it mentions
// one of the dev switches; anything else is recorded as nothing.
let captured = "";

/**
 * Take the dev switches from the address bar now. Called at the very top of
 * Main's bootstrap, ahead of every history write. `env` is read only when the
 * query mentions a switch, and a failure to read it records nothing.
 */
export function captureDevSearch(
  search: string | undefined,
  env: () => GameEnv,
): void {
  captured = "";
  if (!search || !/nationTiming/.test(search)) return;
  try {
    if (env() === GameEnv.Dev) captured = search;
  } catch {
    // No environment to ask (a non-browser host or a broken bootstrap):
    // not a dev build as far as this switch is concerned.
  }
}

/** The query string captured at load, or "" when none was recorded. */
export function devSearch(): string {
  return captured;
}

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

/**
 * `&nationTimingLog=1`: print the nations' wake-ups to the console. The same
 * limits as above: single-player and dev builds only, and only the value 1.
 * Absent or anything else, it returns undefined and nothing is sent.
 */
export function nationTimingLogRequest(
  search: string,
  gameType: GameType,
  env: () => GameEnv,
): true | undefined {
  if (gameType !== GameType.Singleplayer) return undefined;
  if (new URLSearchParams(search).get("nationTimingLog") !== "1") {
    return undefined;
  }
  return env() === GameEnv.Dev ? true : undefined;
}
