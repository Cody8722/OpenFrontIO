// Behaviour pinned: the Human Trace event observer turns the updates a client
// already holds into {"k":"event"} lines, only for events that concern the
// local player, never throws into the game, and never calls anything but
// getters on the view.
import { describe, expect, it } from "vitest";
import { HumanTrace } from "../../src/client/humanTrace/HumanTrace";
import {
  createEventObserver,
  type EventGame,
  type EventKeys,
} from "../../src/client/humanTrace/HumanTraceEvents";

const K: EventKeys = {
  Unit: 1,
  DisplayEvent: 2,
  UnitIncoming: 3,
  AllianceRequest: 4,
  AllianceRequestReply: 5,
  BrokeAlliance: 6,
  AllianceExpired: 7,
  NAVAL_INVASION_INBOUND: 8,
};
const W = 100;

function setup() {
  const sent: string[] = [];
  const trace = new HumanTrace({
    now: () => 0,
    wallNow: () => 0,
    moves: false,
    sink: {
      traceLines: async (_id, lines) => {
        sent.push(...lines);
        return true;
      },
      recordTurns: async () => true,
    },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  trace.start(
    {
      gameID: "evt00001",
      commit: "x",
      mode: "singleplayer",
      map: "m",
      difficulty: "d",
      nations: 0,
      bots: 0,
      seed: "s",
      players: [],
      urlParams: "",
      turnIntervalMs: 100,
      moves: false,
      screen: { w: 1, h: 1, dpr: 1 },
    },
    {},
  );
  const state = {
    tick: 10,
    updates: {} as Record<number, unknown[]>,
    incoming: [] as {
      id: string;
      attackerID: number;
      troops: number;
      retreating: boolean;
    }[],
    units: new Map<number, any>(),
    mine: (x: number, y: number) => x < 20 && y < 20,
  };
  const names: Record<number, string> = { 1: "Me", 2: "Foe", 3: "Pal" };
  const player = (id: number) => ({
    smallID: () => id,
    displayName: () => names[id],
    type: () => "Human",
  });
  const game: EventGame = {
    ticks: () => state.tick,
    myPlayer: () => ({
      ...player(1),
      isAlive: () => true,
      incomingAttacks: () => state.incoming,
    }),
    playerBySmallID: (id) => player(id),
    unit: (id) => state.units.get(id),
    updatesSinceLastTick: () => state.updates,
    x: (r) => r % W,
    y: (r) => Math.floor(r / W),
    isValidCoord: (x, y) => x >= 0 && y >= 0 && x < W && y < W,
    ref: (x, y) => y * W + x,
    owner: (r) => ({
      isPlayer: () => state.mine(r % W, Math.floor(r / W)),
      smallID: () => 1,
    }),
  };
  const observe = createEventObserver(trace, game, K);
  const events = async () => {
    await trace.flush();
    return sent
      .map((l) => JSON.parse(l))
      .filter((r) => r.k === "event") as Record<string, any>[];
  };
  return { state, observe, events };
}

const unit = (type: string, tile: number, extra: object = {}) => ({
  id: () => 7,
  type: () => type,
  tile: () => tile,
  isActive: () => true,
  troops: () => 50,
  targetTile: () => undefined,
  owner: () => ({ smallID: () => 2, displayName: () => "Foe" }),
  ...extra,
});

describe("HumanTrace event observer", () => {
  it("records a new attack on me once, with the source and size", async () => {
    const t = setup();
    t.state.incoming = [
      { id: "a1", attackerID: 2, troops: 1234.6, retreating: false },
    ];
    t.observe();
    t.state.tick = 11;
    t.observe();
    const ev = await t.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      ev: "attacked",
      tick: 10,
      troops: 1235,
      from: { id: 2, name: "Foe" },
    });
  });

  it("records an enemy transport heading for me, then near, then ended", async () => {
    const t = setup();
    t.state.units.set(
      7,
      unit("Transport", 90 * W + 90, { targetTile: () => 10 * W + 10 }),
    );
    t.state.updates = {
      [K.UnitIncoming]: [
        { unitID: 7, messageType: K.NAVAL_INVASION_INBOUND, playerID: 1 },
        // someone else's alert is not mine
        { unitID: 8, messageType: K.NAVAL_INVASION_INBOUND, playerID: 3 },
      ],
    };
    t.observe();
    t.state.updates = {};
    t.state.tick = 11;
    t.observe(); // still far: nothing new
    t.state.units.set(
      7,
      unit("Transport", 20 * W + 20, { targetTile: () => 10 * W + 10 }),
    );
    t.state.tick = 12;
    t.observe();
    t.state.units.set(
      7,
      unit("Transport", 10 * W + 10, {
        targetTile: () => 10 * W + 10,
        isActive: () => false,
      }),
    );
    t.state.tick = 13;
    t.observe();
    const ev = await t.events();
    expect(ev.map((e) => e.ev)).toEqual([
      "transport_inbound",
      "transport_near",
      "transport_ended",
    ]);
    expect(ev[0]).toMatchObject({
      troops: 50,
      landing: { x: 10, y: 10 },
      from: { id: 2 },
    });
  });

  it("records my ship destroyed (no killer available) and my trade ship captured", async () => {
    const t = setup();
    t.state.units.set(7, unit("Warship", 5 * W + 6));
    t.state.updates = {
      [K.DisplayEvent]: [
        { message: "events_display.unit_destroyed", playerID: 1, unitID: 7 },
        {
          message: "events_display.trade_ship_captured",
          playerID: 1,
          unitID: 7,
          params: { name: "Foe" },
        },
        // another player's loss is not mine
        { message: "events_display.unit_destroyed", playerID: 2, unitID: 7 },
      ],
    };
    t.observe();
    const ev = await t.events();
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      ev: "unit_destroyed",
      unit: "Warship",
      at: { x: 6, y: 5 },
      killer: null,
    });
    expect(ev[1]).toMatchObject({ ev: "trade_ship_captured", by: "Foe" });
  });

  it("records a nuke aimed on or near my land, not a far one, not mine", async () => {
    const t = setup();
    const nuke = (id: number, owner: number, target: number) => ({
      id,
      unitType: "Atom Bomb",
      ownerID: owner,
      targetTile: target,
      pos: 90 * W + 90,
    });
    t.state.updates = {
      [K.Unit]: [
        nuke(1, 2, 5 * W + 5), // on my land
        nuke(2, 2, 5 * W + 50), // 30 tiles from my land: near
        nuke(3, 2, 80 * W + 80), // far away
        nuke(4, 1, 5 * W + 5), // my own
      ],
    };
    t.observe();
    t.state.tick = 11;
    t.observe(); // the same units again: no repeat
    const ev = await t.events();
    expect(ev.map((e) => [e.unitId, e.onMyTerritory])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(ev[1].distanceToMine).toBeLessThanOrEqual(40);
  });

  it("records alliance requests, formation, betrayal and expiry that involve me", async () => {
    const t = setup();
    t.state.updates = {
      [K.AllianceRequest]: [
        { requestorID: 2, recipientID: 1 },
        { requestorID: 2, recipientID: 3 }, // not mine
      ],
      [K.AllianceRequestReply]: [
        { request: { requestorID: 1, recipientID: 2 }, accepted: true },
      ],
      [K.BrokeAlliance]: [{ traitorID: 2, betrayedID: 1 }],
      [K.AllianceExpired]: [{ player1ID: 3, player2ID: 1 }],
    };
    t.observe();
    const ev = await t.events();
    expect(ev.map((e) => e.ev)).toEqual([
      "alliance_request_received",
      "alliance_formed",
      "alliance_broken",
      "alliance_expired",
    ]);
    expect(ev[2]).toMatchObject({ iBetrayed: false });
  });

  it("does not throw into the game when the view misbehaves", () => {
    const t = setup();
    t.state.updates = {
      [K.UnitIncoming]: [null as never],
      [K.Unit]: [{} as never],
    };
    expect(() => t.observe()).not.toThrow();
  });
});
