// Behaviour pinned: Human Trace records inputs, intents and the turn stream of
// a single-player dev game without touching what the game does. It is off
// unless `&humanTrace=` is captured at page load on a dev build; a failing
// sink or store never reaches the game; the listeners are passive; text typed
// into a field is never recorded.
import { GameType } from "@openfront/engine-api/game/GameTypes";
import type { GameStartInfo } from "@openfront/engine-api/Schemas";
import { GameEnv } from "@openfront/shared/configuration/Env";
import { EventBus } from "@openfront/shared/EventBus";
import type { ServerMessage } from "@openfront/shared/WireSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureDevSearch } from "../../src/client/DevNationTiming";
import {
  HumanTrace,
  type FallbackStore,
  type TraceSink,
} from "../../src/client/humanTrace/HumanTrace";
import { attachInputHook } from "../../src/client/humanTrace/HumanTraceHook";
import {
  assembleFromChunks,
  humanTraceRequest,
} from "../../src/client/humanTrace/HumanTraceSinks";

vi.mock("../../src/client/Auth", () => ({
  getAuthHeader: vi.fn(async () => ""),
  getPersistentID: vi.fn(() => "123e4567-e89b-12d3-a456-426614174000"),
}));
vi.mock("../../src/client/Api", () => ({ getApiBase: vi.fn(() => "") }));
vi.mock("src/client/ClientEnv", () => ({
  ClientEnv: {
    turnIntervalMs: vi.fn(() => 100),
    gitCommit: vi.fn(() => "abc1234"),
    env: vi.fn(() => 0),
    gameHttpBase: vi.fn(() => "http://t"),
    gameWorkerPath: vi.fn(() => "w0"),
  },
}));

import { LocalServer } from "../../src/client/LocalServer";

const info = (moves = false) => ({
  gameID: "trace001",
  commit: "abc1234",
  mode: "singleplayer" as const,
  map: "Africa",
  difficulty: "Hard",
  nations: "default",
  bots: 100,
  seed: "simpleHash(gameID=trace001)",
  players: [{ clientID: "abCD1234", username: "p" }],
  urlParams: "?humanTrace=1&nationTiming=0.5",
  turnIntervalMs: 100,
  moves,
  screen: { w: 1280, h: 720, dpr: 2 },
});

function makeSink(ok = true) {
  const lines: string[] = [];
  const records: { header: object | null; turns: object[] }[] = [];
  const sink: TraceSink = {
    traceLines: async (_id, l) => {
      if (!ok) return false;
      lines.push(...l);
      return true;
    },
    recordTurns: async (_id, header, turns) => {
      if (!ok) return false;
      records.push({ header, turns });
      return true;
    },
  };
  return { sink, lines, records };
}

let clock = 1000;
const opts = (sink: TraceSink, fallback?: FallbackStore, moves = false) => ({
  now: () => clock,
  wallNow: () => 1_700_000_000_000,
  sink,
  fallback,
  moves,
  setTimer: () => 1,
  clearTimer: () => {},
});

describe("humanTraceRequest", () => {
  const dev = () => GameEnv.Dev;
  it("needs single-player, dev and a known value", () => {
    expect(humanTraceRequest("?humanTrace=1", GameType.Singleplayer, dev)).toBe(
      "basic",
    );
    expect(
      humanTraceRequest("?humanTrace=moves", GameType.Singleplayer, dev),
    ).toBe("moves");
    expect(
      humanTraceRequest("?humanTrace=1", GameType.Public, dev),
    ).toBeUndefined();
    expect(
      humanTraceRequest(
        "?humanTrace=1",
        GameType.Singleplayer,
        () => GameEnv.Prod,
      ),
    ).toBeUndefined();
    expect(
      humanTraceRequest("?humanTrace=2", GameType.Singleplayer, dev),
    ).toBeUndefined();
    expect(humanTraceRequest("", GameType.Singleplayer, dev)).toBeUndefined();
  });
  it("does not read the environment when nothing was asked for", () => {
    const env = vi.fn(() => GameEnv.Dev);
    humanTraceRequest("?x=1", GameType.Singleplayer, env);
    expect(env).not.toHaveBeenCalled();
  });
});

describe("HumanTrace core", () => {
  beforeEach(() => {
    clock = 1000;
  });

  it("writes a complete header and every line parses", async () => {
    const { sink, lines } = makeSink();
    const t = new HumanTrace(opts(sink));
    t.setContext({
      tick: () => 7,
      summary: () => ({ gold: 5 }),
      camera: () => ({ scale: 2, x: 1, y: 2 }),
    });
    t.start(info(), { gameID: "trace001" });
    clock = 1250;
    t.input({ type: "pointerdown", x: 1, y: 2 });
    t.intent({ type: "build_unit", unit: "Warship", tile: 5 }, 3, "sent");
    await t.end();
    const rows = lines.map((l) => JSON.parse(l));
    const header = rows[0];
    for (const key of [
      "gameID",
      "commit",
      "mode",
      "map",
      "difficulty",
      "nations",
      "seed",
      "players",
      "urlParams",
      "screen",
      "startedAtWall",
      "version",
      "tickBase",
    ]) {
      expect(header).toHaveProperty(key);
    }
    expect(header.screen).toEqual({ w: 1280, h: 720, dpr: 2 });
    expect(header.urlParams).toContain("nationTiming=0.5");
    expect(rows[1]).toMatchObject({ k: "input", tMs: 250, tick: 7 });
    expect(rows[2]).toMatchObject({
      k: "intent",
      type: "build_unit",
      outcome: "sent",
      serverTick: 3,
      state: { gold: 5 },
    });
    expect(rows[rows.length - 1].k).toBe("end");
  });

  it("marks a paused drop with its reason", async () => {
    const { sink, lines } = makeSink();
    const t = new HumanTrace(opts(sink));
    t.start(info());
    t.intent({ type: "build_unit" }, 1, "dropped_paused");
    await t.end();
    const row = lines.map((l) => JSON.parse(l)).find((r) => r.k === "intent");
    expect(row).toMatchObject({ outcome: "dropped_paused", reason: "paused" });
  });

  it("records each turn on arrival and sends the header once", async () => {
    const { sink, records } = makeSink();
    const t = new HumanTrace(opts(sink));
    t.start(info(), { gameID: "trace001" });
    clock = 1100;
    t.turn({ turnNumber: 0, intents: [] });
    await t.flush();
    clock = 1200;
    t.turn({ turnNumber: 1, intents: [{ type: "spawn", tile: 3 }] });
    await t.flush();
    expect(records).toHaveLength(2);
    expect(records[0].header).toMatchObject({
      gameID: "trace001",
      gameStartInfo: { gameID: "trace001" },
    });
    expect(records[1].header).toBeNull();
    expect(records[0].turns).toEqual([
      { turnNumber: 0, intents: [], arrivalMs: 100 },
    ]);
    expect(records[1].turns[0]).toMatchObject({
      turnNumber: 1,
      arrivalMs: 200,
    });
  });

  it("falls back to the browser store when the sink fails", async () => {
    const { sink } = makeSink(false);
    const stored: unknown[] = [];
    const t = new HumanTrace(
      opts(sink, {
        store: async (_g, kind, payload) => {
          stored.push({ kind, payload });
        },
      }),
    );
    t.start(info());
    t.turn({ turnNumber: 0, intents: [] });
    await t.end();
    expect(stored.map((s) => (s as { kind: string }).kind).sort()).toEqual([
      "record",
      "trace",
    ]);
    const rebuilt = assembleFromChunks(
      stored as { kind: "trace" | "record"; payload: unknown }[],
    );
    expect(JSON.parse(rebuilt.trace.split("\n")[0]).k).toBe("header");
    expect(JSON.parse(rebuilt.record).turns).toHaveLength(1);
  });

  it("never throws when the sink and the store both fail", async () => {
    const t = new HumanTrace(
      opts(
        {
          traceLines: async () => {
            throw new Error("down");
          },
          recordTurns: async () => {
            throw new Error("down");
          },
        },
        {
          store: async () => {
            throw new Error("full");
          },
        },
      ),
    );
    t.start(info());
    t.input({ type: "key" });
    t.turn({ turnNumber: 0, intents: [] });
    await expect(t.end()).resolves.toBeUndefined();
  });

  it("a throwing context reader does not disturb the caller", () => {
    const { sink } = makeSink();
    const t = new HumanTrace(opts(sink));
    t.setContext({
      tick: () => {
        throw new Error("boom");
      },
      summary: () => {
        throw new Error("boom");
      },
      camera: () => {
        throw new Error("boom");
      },
    });
    t.start(info());
    expect(() => {
      t.input({ type: "x" });
      t.intent({ type: "attack" }, 0, "sent");
      t.camera();
    }).not.toThrow();
  });

  it("keeps memory bounded while nothing can be sent", () => {
    const { sink } = makeSink();
    const t = new HumanTrace(opts(sink));
    t.start(info());
    for (let i = 0; i < 20000; i++) {
      t.input({ type: "move", i });
      t.turn({ turnNumber: i, intents: [] });
    }
    const p = t.pending();
    expect(p.lines).toBeLessThanOrEqual(4000);
    expect(p.turns).toBeLessThanOrEqual(4000);
    expect(p.droppedLines).toBeGreaterThan(0);
    expect(p.droppedTurns).toBeGreaterThan(0);
  });

  it("limits camera lines to 4 Hz and only on change", async () => {
    const { sink, lines } = makeSink();
    const t = new HumanTrace(opts(sink));
    let x = 0;
    t.setContext({
      tick: () => 0,
      summary: () => undefined,
      camera: () => ({ scale: 1, x, y: 0 }),
    });
    t.start(info());
    for (let ms = 0; ms < 1000; ms += 20) {
      clock = 1000 + ms;
      x = ms; // moving every call
      t.camera();
    }
    await t.end();
    const cams = lines
      .map((l) => JSON.parse(l))
      .filter((r) => r.k === "camera");
    expect(cams.length).toBeLessThanOrEqual(4);
    expect(cams.length).toBeGreaterThanOrEqual(3);
  });
});

describe("input hook", () => {
  function setup(moves: boolean) {
    const { sink, lines } = makeSink();
    const t = new HumanTrace(opts(sink, undefined, moves));
    t.start(info(moves));
    let now = 0;
    const stop = attachInputHook(
      t,
      {
        toWorld: (x, y) => ({ x: x / 10, y: y / 10 }),
        ownerAt: () => ({ owner: 3, isPlayer: true }),
        ghost: () => "Warship",
      },
      window,
      () => now,
    );
    return {
      t,
      lines,
      stop,
      setNow: (n: number) => (now = n),
      rows: async () => {
        await t.flush();
        return lines.map((l) => JSON.parse(l));
      },
    };
  }
  const ptr = (type: string, x: number, y: number, init = {}) =>
    new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, ...init });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("records pointer down/up with world cell, target and selected unit", async () => {
    const h = setup(false);
    window.dispatchEvent(ptr("pointerdown", 100, 50, { button: 0 }));
    h.setNow(120);
    window.dispatchEvent(ptr("pointerup", 100, 50, { button: 0 }));
    const rows = await h.rows();
    h.stop();
    const down = rows.find((r) => r.type === "pointerdown");
    expect(down).toMatchObject({
      x: 100,
      y: 50,
      world: { x: 10, y: 5 },
      target: { owner: 3, isPlayer: true },
      selected: "Warship",
    });
    expect(rows.find((r) => r.type === "pointerup")).toMatchObject({
      heldMs: 120,
    });
  });

  it("is passive: the page's own handlers still see the event, unchanged", () => {
    const h = setup(false);
    let seen: Event | undefined;
    const own = (e: Event) => (seen = e);
    window.addEventListener("pointerdown", own);
    const ev = ptr("pointerdown", 1, 1, { cancelable: true });
    window.dispatchEvent(ev);
    window.removeEventListener("pointerdown", own);
    h.stop();
    expect(seen).toBe(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("tells a drag from a click", async () => {
    const h = setup(false);
    window.dispatchEvent(ptr("pointerdown", 0, 0));
    window.dispatchEvent(ptr("pointerup", 80, 0));
    const rows = await h.rows();
    h.stop();
    expect(rows.some((r) => r.type === "drag")).toBe(true);
  });

  it("does not record keys typed into a text field, but records hotkeys", async () => {
    const h = setup(false);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyA", key: "a", bubbles: true }),
    );
    input.blur();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyB", key: "b", bubbles: true }),
    );
    const rows = await h.rows();
    h.stop();
    const keys = rows.filter((r) => r.type === "key").map((r) => r.code);
    expect(keys).toEqual(["KeyB"]);
    expect(JSON.stringify(rows)).not.toContain("KeyA");
  });

  it("mouse moves are only recorded in moves mode, at most 20 per second", async () => {
    const off = setup(false);
    off.setNow(0);
    window.dispatchEvent(ptr("pointermove", 1, 1));
    expect((await off.rows()).some((r) => r.type === "move")).toBe(false);
    off.stop();

    const on = setup(true);
    for (let ms = 0; ms < 1000; ms += 5) {
      on.setNow(ms);
      window.dispatchEvent(ptr("pointermove", ms, 0));
    }
    const moves = (await on.rows()).filter((r) => r.type === "move");
    on.stop();
    expect(moves.length).toBeLessThanOrEqual(20);
    expect(moves.length).toBeGreaterThanOrEqual(18);
  });

  it("stops listening when detached", async () => {
    const h = setup(false);
    h.stop();
    window.dispatchEvent(ptr("pointerdown", 1, 1));
    expect((await h.rows()).some((r) => r.type === "pointerdown")).toBe(false);
  });
});

describe("LocalServer with a trace", () => {
  const CLIENT_ID = "abCD1234";
  const startInfo = {
    gameID: "trace001",
    lobbyCreatedAt: 1,
    config: {
      gameMap: "Africa",
      difficulty: "Hard",
      gameType: "Singleplayer",
      nations: "default",
      bots: 100,
    },
    players: [{ clientID: CLIENT_ID, username: "p", clanTag: null }],
  } as unknown as GameStartInfo;

  const posts: { url: string; body: any }[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    posts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response("{}", { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    captureDevSearch("", () => GameEnv.Dev);
  });

  function play(withTrace: boolean): ServerMessage[] {
    captureDevSearch(withTrace ? "?humanTrace=1" : "", () => GameEnv.Dev);
    const out: ServerMessage[] = [];
    const server = new LocalServer(
      { gameStartInfo: startInfo, playerName: "p", playerClanTag: null } as any,
      false,
      new EventBus(),
    );
    server.updateCallback(
      () => {},
      (m) => out.push(m),
    );
    server.start();
    const step = () => {
      vi.advanceTimersByTime(110);
      server.turnComplete();
    };
    step();
    server.onMessage({
      type: "intent",
      intent: { type: "build_unit", unit: "Warship", tile: 5 },
    } as any);
    step();
    server.onMessage({
      type: "intent",
      intent: { type: "toggle_pause", paused: true },
    } as any);
    server.onMessage({
      type: "intent",
      intent: { type: "build_unit", unit: "Warship", tile: 6 },
    } as any);
    server.onMessage({
      type: "intent",
      intent: { type: "toggle_pause", paused: false },
    } as any);
    step();
    step();
    server.endGame();
    return out;
  }

  it("the game sees exactly the same messages with and without the trace", () => {
    const without = play(false);
    const withTrace = play(true);
    expect(JSON.stringify(withTrace)).toBe(JSON.stringify(without));
  });

  it("writes intents with their outcome and every turn to the record", async () => {
    play(true);
    await vi.runOnlyPendingTimersAsync();
    const traceRows = posts
      .filter((p) => p.url.endsWith("/trace"))
      .flatMap((p) => p.body.lines as string[])
      .map((l) => JSON.parse(l));
    const intents = traceRows.filter((r) => r.k === "intent");
    expect(intents.map((r) => [r.type, r.outcome])).toEqual([
      ["build_unit", "sent"],
      ["toggle_pause", "sent"],
      ["build_unit", "dropped_paused"],
      ["toggle_pause", "sent"],
    ]);
    expect(traceRows[0]).toMatchObject({
      k: "header",
      gameID: "trace001",
      commit: "abc1234",
      urlParams: "?humanTrace=1",
    });
    const turns = posts
      .filter((p) => p.url.endsWith("/record"))
      .flatMap((p) => p.body.turns as { turnNumber: number }[]);
    expect(turns.map((t) => t.turnNumber)).toEqual(turns.map((_, i) => i));
    expect(turns.length).toBeGreaterThanOrEqual(4);
    expect(
      posts.find((p) => p.url.endsWith("/record"))?.body.header,
    ).toMatchObject({ gameID: "trace001", map: "Africa", difficulty: "Hard" });
  });

  it("sends nothing and records nothing without the switch", async () => {
    play(false);
    await vi.runOnlyPendingTimersAsync();
    expect(posts.filter((p) => p.url.includes("human-trace"))).toHaveLength(0);
  });

  it("a trace whose sink throws does not change the game's messages", () => {
    const baseline = play(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const broken = play(true);
    expect(JSON.stringify(broken)).toBe(JSON.stringify(baseline));
  });
});
