import { GameType } from "@openfront/engine-api/game/GameTypes";
import { GameEnv } from "@openfront/shared/configuration/Env";
import type { FallbackStore, TraceSink } from "./HumanTrace";

/**
 * `&humanTrace=1` records inputs and intents; `&humanTrace=moves` adds the
 * mouse path at about 20 Hz. Only a single-player game on a dev build.
 */
export function humanTraceRequest(
  search: string,
  gameType: GameType,
  env: () => GameEnv,
): "basic" | "moves" | undefined {
  if (gameType !== GameType.Singleplayer) return undefined;
  const raw = new URLSearchParams(search).get("humanTrace");
  if (raw !== "1" && raw !== "moves") return undefined;
  try {
    if (env() !== GameEnv.Dev) return undefined;
  } catch {
    return undefined;
  }
  return raw === "moves" ? "moves" : "basic";
}

/** Posts batches to the dev worker's /api/human-trace endpoint. */
export class HttpTraceSink implements TraceSink {
  constructor(
    private base: (gameID: string) => string,
    private post: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async send(url: string, body: unknown): Promise<boolean> {
    try {
      const res = await this.post(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: false,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  traceLines(gameID: string, lines: string[]): Promise<boolean> {
    return this.send(`${this.base(gameID)}/trace`, { lines });
  }

  recordTurns(
    gameID: string,
    header: object | null,
    turns: object[],
  ): Promise<boolean> {
    return this.send(`${this.base(gameID)}/record`, { header, turns });
  }
}

const DB_NAME = "human-trace";
const STORE = "chunks";

/** Browser-side copy of the batches the server did not take. */
export class IdbTraceStore implements FallbackStore {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async store(
    gameID: string,
    kind: "trace" | "record",
    payload: unknown,
  ): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add({ gameID, kind, payload, at: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async all(
    gameID: string,
  ): Promise<{ kind: "trace" | "record"; payload: unknown }[]> {
    const db = await this.open();
    const rows = await new Promise<
      { gameID: string; kind: "trace" | "record"; payload: unknown }[]
    >((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.filter((r) => r.gameID === gameID);
  }
}

/** The text of the two files, rebuilt from what the browser kept. */
export function assembleFromChunks(
  rows: { kind: "trace" | "record"; payload: unknown }[],
): { trace: string; record: string } {
  const lines: string[] = [];
  let header: object | null = null;
  const turns: object[] = [];
  for (const r of rows) {
    if (r.kind === "trace") lines.push(...(r.payload as string[]));
    else {
      const p = r.payload as { header: object | null; turns: object[] };
      if (p.header !== null && header === null) header = p.header;
      turns.push(...p.turns);
    }
  }
  return {
    trace: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    record: JSON.stringify({ version: 1, header, turns }),
  };
}

function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Download what the browser holds for this game (the batches the server missed). */
export async function downloadFromBrowser(
  gameID: string,
  store: IdbTraceStore,
): Promise<void> {
  const { trace, record } = assembleFromChunks(await store.all(gameID));
  saveText(`${gameID}.jsonl`, trace);
  saveText(`${gameID}.record.json`, record);
}
