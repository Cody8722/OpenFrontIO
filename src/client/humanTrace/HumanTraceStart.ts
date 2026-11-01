import { GameType, MessageType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type { GameStartInfo } from "@openfront/engine-api/Schemas";
import { ClientEnv } from "../ClientEnv";
import { devSearch } from "../DevNationTiming";
import {
  activeHumanTrace,
  HumanTrace,
  setActiveHumanTrace,
  type TraceContext,
} from "./HumanTrace";
import { createEventObserver, type EventGame } from "./HumanTraceEvents";
import { attachInputHook, gameContext, type HookEnv } from "./HumanTraceHook";
import {
  downloadFromBrowser,
  HttpTraceSink,
  humanTraceRequest,
  IdbTraceStore,
} from "./HumanTraceSinks";

function endpointBase(gameID: string): string {
  return `${ClientEnv.gameHttpBase(gameID)}/${ClientEnv.gameWorkerPath(gameID)}/api/human-trace/${gameID}`;
}

/**
 * Called by the local server when a single-player game starts. Returns the
 * trace when `&humanTrace=` asked for it on a dev build; undefined otherwise.
 * Never throws.
 */
export function beginHumanTrace(
  startInfo: GameStartInfo | undefined,
): HumanTrace | undefined {
  try {
    if (startInfo === undefined) return undefined;
    const mode = humanTraceRequest(devSearch(), GameType.Singleplayer, () =>
      ClientEnv.env(),
    );
    if (mode === undefined) return undefined;
    const store = new IdbTraceStore();
    const trace = new HumanTrace({
      now: () => performance.now(),
      wallNow: () => Date.now(),
      sink: new HttpTraceSink(endpointBase),
      fallback: store,
      moves: mode === "moves",
    });
    const cfg = startInfo.config as unknown as Record<string, unknown>;
    trace.start(
      {
        gameID: startInfo.gameID,
        commit: ClientEnv.gitCommit(),
        mode: "singleplayer",
        map: String(cfg.gameMap),
        difficulty: String(cfg.difficulty),
        nations: cfg.nations as string | number,
        bots: cfg.bots as number | undefined,
        seed: `simpleHash(gameID=${startInfo.gameID})`,
        players: startInfo.players.map((p) => ({
          clientID: p.clientID,
          username: p.username,
        })),
        urlParams: devSearch(),
        turnIntervalMs: ClientEnv.turnIntervalMs(),
        moves: mode === "moves",
        screen: {
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio,
        },
      },
      startInfo,
    );
    setActiveHumanTrace(trace);
    return trace;
  } catch {
    return undefined;
  }
}

/** The page side: input listeners and a context that reads the game. */
export function attachHumanTraceToGame(parts: {
  game: Parameters<typeof gameContext>[0] & {
    isValidCoord(x: number, y: number): boolean;
    ref(x: number, y: number): number;
    owner(t: number): { isPlayer(): boolean; smallID(): number };
  };
  transform: Parameters<typeof gameContext>[1] & {
    screenToWorldCoordinates(x: number, y: number): { x: number; y: number };
  };
  uiState: { ghostStructure: string | null };
}): { stop: () => void; tick: () => void } | undefined {
  try {
    const trace = activeHumanTrace();
    if (trace === undefined) return undefined;
    const ctx: TraceContext = gameContext(parts.game, parts.transform);
    trace.setContext(ctx);
    const env: HookEnv = {
      toWorld: (x, y) => {
        try {
          // A plain {x,y}: the Cell object carries extra fields (strRepr).
          const c = parts.transform.screenToWorldCoordinates(x, y);
          return { x: c.x, y: c.y };
        } catch {
          return undefined;
        }
      },
      ownerAt: (wx, wy) => {
        try {
          if (!parts.game.isValidCoord(wx, wy)) return undefined;
          const o = parts.game.owner(parts.game.ref(wx, wy));
          return { owner: o.smallID(), isPlayer: o.isPlayer() };
        } catch {
          return undefined;
        }
      },
      ghost: () => parts.uiState.ghostStructure,
    };
    const stop = attachInputHook(trace, env);
    // Called by the page once per game update, after the view took it in.
    const tick = createEventObserver(
      trace,
      parts.game as unknown as EventGame,
      {
        Unit: GameUpdateType.Unit,
        DisplayEvent: GameUpdateType.DisplayEvent,
        UnitIncoming: GameUpdateType.UnitIncoming,
        AllianceRequest: GameUpdateType.AllianceRequest,
        AllianceRequestReply: GameUpdateType.AllianceRequestReply,
        BrokeAlliance: GameUpdateType.BrokeAlliance,
        AllianceExpired: GameUpdateType.AllianceExpired,
        NAVAL_INVASION_INBOUND: MessageType.NAVAL_INVASION_INBOUND,
      },
    );
    return { stop, tick };
  } catch {
    return undefined;
  }
}

/** A dev-only button that downloads the trace once the game is decided. */
export async function showTraceDownload(gameID: string): Promise<void> {
  try {
    if (document.getElementById("human-trace-download") !== null) return;
    // Loaded here so the local server does not pull the UI helpers in for
    // every game, only for a recorded one.
    const { translateText } = await import("../Utils");
    const store = new IdbTraceStore();
    const btn = document.createElement("button");
    btn.id = "human-trace-download";
    btn.textContent = translateText("human_trace.download");
    btn.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:99999;padding:8px 12px;";
    btn.onclick = () => {
      void (async () => {
        try {
          // The server has the files; the browser holds only what it missed.
          const base = endpointBase(gameID);
          for (const [kind, name] of [
            ["trace", `${gameID}.jsonl`],
            ["record", `${gameID}.record.json`],
          ] as const) {
            const res = await fetch(`${base}/${kind}`);
            if (!res.ok) throw new Error(String(res.status));
            const url = URL.createObjectURL(await res.blob());
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            a.click();
            URL.revokeObjectURL(url);
          }
        } catch {
          await downloadFromBrowser(gameID, store);
        }
      })();
    };
    document.body.appendChild(btn);
  } catch {
    // no button, no harm
  }
}
