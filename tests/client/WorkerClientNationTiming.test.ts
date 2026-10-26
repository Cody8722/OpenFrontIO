// Behaviour pinned: WorkerClient.initialize puts the dev nation-timing request
// from the page URL (?nationTiming=0.5) into the init message as the one
// optional field `nationTiming`, and only for a single-player game on a dev
// build; otherwise the field is absent.
import {
  GameMapSize,
  GameMapType,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import type { GameStartInfo } from "@openfront/engine-api/Schemas";
import { GameEnv } from "@openfront/shared/configuration/Env";
import { captureDevSearch } from "../../src/client/DevNationTiming";
import { WorkerClient } from "../../src/client/WorkerClient";

const worker = vi.hoisted(() => ({
  posted: [] as Record<string, unknown>[],
  listeners: [] as ((e: MessageEvent) => void)[],
}));
const env = vi.hoisted(() => ({ value: 0 as number }));

vi.mock("@openfront/engine/worker/Worker.worker?worker&inline", () => ({
  default: class {
    addEventListener(_type: string, l: (e: MessageEvent) => void) {
      worker.listeners.push(l);
    }
    postMessage(msg: Record<string, unknown>) {
      worker.posted.push(msg);
    }
    terminate() {}
  },
}));

vi.mock("../../src/client/ClientEnv", () => ({
  ClientEnv: { env: () => env.value },
}));

vi.mock("../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: {
    getMapData: () => {
      const bin = async () => new Uint8Array(4);
      return {
        manifest: async () => ({ name: "onion" }),
        mapBin: bin,
        map4xBin: bin,
        map16xBin: bin,
      };
    },
  },
}));

function startInfo(gameType: GameType): GameStartInfo {
  return {
    gameID: "timingWire1",
    config: {
      gameMap: GameMapType.Onion,
      gameMapSize: GameMapSize.Normal,
      gameType,
    },
  } as unknown as GameStartInfo;
}

async function initMessage(
  search: string,
  gameType: GameType,
  gameEnv: GameEnv,
): Promise<Record<string, unknown>> {
  worker.posted = [];
  worker.listeners = [];
  env.value = gameEnv;
  // Load the page with the query, let Main take it, then rewrite the address
  // bar the way a game start does: the query is gone when WorkerClient runs.
  window.history.replaceState({}, "", `/${search}`);
  captureDevSearch(window.location.search, () => env.value);
  window.history.replaceState(null, "", "/w0/game/timingWire1");
  expect(window.location.search).toBe("");
  const ready = new WorkerClient(startInfo(gameType), undefined).initialize();
  await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
  const msg = worker.posted[0];
  for (const l of worker.listeners) {
    l(
      new MessageEvent("message", {
        data: { type: "initialized", id: msg.id },
      }),
    );
  }
  await ready;
  return msg;
}

describe("WorkerClient nationTiming init field", () => {
  test("single-player on a dev build sends the requested spread", async () => {
    const msg = await initMessage(
      "?nationTiming=0.5",
      GameType.Singleplayer,
      GameEnv.Dev,
    );
    expect(msg.nationTiming).toBe(0.5);
  });

  test("a multiplayer room never sends it", async () => {
    for (const gameType of [GameType.Public, GameType.Private]) {
      const msg = await initMessage("?nationTiming=0.5", gameType, GameEnv.Dev);
      expect(msg.nationTiming).toBeUndefined();
    }
  });

  test("staging and production builds never send it", async () => {
    for (const gameEnv of [GameEnv.Preprod, GameEnv.Prod]) {
      const msg = await initMessage(
        "?nationTiming=0.5",
        GameType.Singleplayer,
        gameEnv,
      );
      expect(msg.nationTiming).toBeUndefined();
    }
  });

  test("without the parameter the field is absent", async () => {
    const msg = await initMessage("", GameType.Singleplayer, GameEnv.Dev);
    expect(msg.nationTiming).toBeUndefined();
  });
});

describe("WorkerClient nationTimingLog init field", () => {
  test("single-player on a dev build with =1 sends true", async () => {
    const msg = await initMessage(
      "?nationTimingLog=1",
      GameType.Singleplayer,
      GameEnv.Dev,
    );
    expect(msg.nationTimingLog).toBe(true);
  });

  test("a multiplayer room, staging and production never send it", async () => {
    for (const [type, gameEnv] of [
      [GameType.Public, GameEnv.Dev],
      [GameType.Private, GameEnv.Dev],
      [GameType.Singleplayer, GameEnv.Preprod],
      [GameType.Singleplayer, GameEnv.Prod],
    ] as const) {
      const msg = await initMessage("?nationTimingLog=1", type, gameEnv);
      expect(msg.nationTimingLog).toBeUndefined();
    }
  });

  test("without the parameter the field is absent", async () => {
    const msg = await initMessage("", GameType.Singleplayer, GameEnv.Dev);
    expect(msg.nationTimingLog).toBeUndefined();
  });
});
