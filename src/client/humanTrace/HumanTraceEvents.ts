// Human Trace event stream: the player-related events the client already
// receives each tick, written as {"k":"event"} lines. Read-only: it looks at
// the update batch the page already holds (`updatesSinceLastTick`) and at
// GameView getters, never sends anything and never calls anything that
// changes state. Every part is wrapped so a failure cannot reach the game.
import type { HumanTrace } from "./HumanTrace";

/** The parts of the page's GameView this observer reads. */
export interface EventGame {
  ticks(): number;
  myPlayer(): EventPlayer | null;
  playerBySmallID(id: number): EventPlayerLike | undefined;
  unit(id: number): EventUnit | undefined;
  updatesSinceLastTick(): Record<number, unknown[] | undefined> | null;
  x(ref: number): number;
  y(ref: number): number;
  isValidCoord(x: number, y: number): boolean;
  ref(x: number, y: number): number;
  owner(ref: number): { isPlayer(): boolean; smallID(): number };
}

export interface EventPlayerLike {
  smallID(): number;
  displayName(): string;
  type?(): string;
}
export interface EventPlayer extends EventPlayerLike {
  isAlive(): boolean;
  incomingAttacks(): {
    id: string;
    attackerID: number;
    troops: number;
    retreating: boolean;
  }[];
}
export interface EventUnit {
  id(): number;
  type(): string;
  tile(): number;
  isActive(): boolean;
  troops(): number;
  targetTile(): number | undefined;
  owner(): EventPlayerLike;
}

/** Numeric values of the engine's GameUpdateType / MessageType, passed in. */
export interface EventKeys {
  Unit: number;
  DisplayEvent: number;
  UnitIncoming: number;
  AllianceRequest: number;
  AllianceRequestReply: number;
  BrokeAlliance: number;
  AllianceExpired: number;
  NAVAL_INVASION_INBOUND: number;
}

const NUKE_TYPES = new Set(["Atom Bomb", "Hydrogen Bomb", "MIRV"]);
const NEAR_TRANSPORT_TILES = 25; // boat this close to its landing tile
const NEAR_NUKE_TILES = 40; // a nuke aimed this close to my land counts
const NEAR_STEP = 8;

export function createEventObserver(
  trace: HumanTrace,
  game: EventGame,
  keys: EventKeys,
): () => void {
  const boats = new Map<number, { near: boolean }>();
  const nukes = new Set<number>();
  let attacks = new Set<string>();
  let lastTick = -1;

  const who = (id: number | undefined) => {
    if (id === undefined) return undefined;
    const p = game.playerBySmallID(id);
    if (!p) return { id };
    return {
      id,
      name: safeStr(() => p.displayName()),
      type: safeStr(() => p.type?.()),
    };
  };
  const xy = (ref: number | undefined) =>
    ref === undefined ? undefined : { x: game.x(ref), y: game.y(ref) };

  const emit = (name: string, extra: Record<string, unknown>) =>
    trace.event("event", { ev: name, tick: game.ticks(), ...extra });

  // Smallest sampled distance from a tile to land that I own (undefined when
  // nothing of mine is within NEAR_NUKE_TILES). A coarse grid, not exact.
  const distToMine = (ref: number, me: number): number | undefined => {
    const cx = game.x(ref);
    const cy = game.y(ref);
    let best: number | undefined;
    for (let dy = -NEAR_NUKE_TILES; dy <= NEAR_NUKE_TILES; dy += NEAR_STEP) {
      for (let dx = -NEAR_NUKE_TILES; dx <= NEAR_NUKE_TILES; dx += NEAR_STEP) {
        const x = cx + dx;
        const y = cy + dy;
        if (!game.isValidCoord(x, y)) continue;
        const o = game.owner(game.ref(x, y));
        if (o.isPlayer() && o.smallID() === me) {
          const d = Math.round(Math.hypot(dx, dy));
          if (best === undefined || d < best) best = d;
        }
      }
    }
    return best;
  };

  return () => {
    try {
      const me = game.myPlayer();
      const tick = game.ticks();
      if (!me || tick === lastTick) return;
      lastTick = tick;
      const meId = me.smallID();
      const u = game.updatesSinceLastTick();

      // 1. attacks on me: the attack panel's source, the player's incoming list
      if (me.isAlive()) {
        const now = new Set<string>();
        for (const a of me.incomingAttacks()) {
          now.add(a.id);
          if (attacks.has(a.id)) continue;
          emit("attacked", {
            from: who(a.attackerID),
            troops: Math.round(a.troops),
            attackId: a.id,
          });
        }
        attacks = now;
      }

      if (u) {
        // 2. enemy transport boats heading for me (the "naval invasion" alert)
        for (const e of (u[keys.UnitIncoming] ?? []) as {
          unitID: number;
          messageType: number;
          playerID: number;
        }[]) {
          if (e.playerID !== meId) continue;
          if (e.messageType === keys.NAVAL_INVASION_INBOUND) {
            const b = game.unit(e.unitID);
            boats.set(e.unitID, { near: false });
            emit("transport_inbound", {
              unitId: e.unitID,
              from: who(b?.owner().smallID()),
              troops: b?.troops(),
              at: xy(b?.tile()),
              landing: xy(b?.targetTile()),
            });
          }
        }
        // 3, 4. my ships destroyed / my trade ship captured (event-feed messages)
        for (const e of (u[keys.DisplayEvent] ?? []) as {
          message: string;
          playerID: number | null;
          unitID?: number;
          params?: Record<string, string | number>;
        }[]) {
          if (e.playerID !== meId) continue;
          if (e.message === "events_display.unit_destroyed") {
            const un = e.unitID === undefined ? undefined : game.unit(e.unitID);
            emit("unit_destroyed", {
              unitId: e.unitID,
              unit: un?.type() ?? e.params?.unit,
              at: xy(un?.tile()),
              // The engine does not put the destroyer into any update.
              killer: null,
            });
          } else if (e.message === "events_display.trade_ship_captured") {
            const un = e.unitID === undefined ? undefined : game.unit(e.unitID);
            emit("trade_ship_captured", {
              unitId: e.unitID,
              by: e.params?.name,
              at: xy(un?.tile()),
            });
          }
        }
        // 5. nukes launched by someone else, aimed at or near my land
        for (const un of (u[keys.Unit] ?? []) as {
          id: number;
          unitType: string;
          ownerID: number;
          targetTile?: number;
          pos: number;
        }[]) {
          if (!NUKE_TYPES.has(un.unitType) || nukes.has(un.id)) continue;
          nukes.add(un.id);
          if (un.ownerID === meId || un.targetTile === undefined) continue;
          const o = game.owner(un.targetTile);
          const onMine = o.isPlayer() && o.smallID() === meId;
          const d = onMine ? 0 : distToMine(un.targetTile, meId);
          if (d === undefined) continue;
          emit("nuke_launched", {
            unitId: un.id,
            unit: un.unitType,
            from: who(un.ownerID),
            launchedAt: xy(un.pos),
            target: xy(un.targetTile),
            onMyTerritory: onMine,
            distanceToMine: d,
          });
        }
        // 6. alliances
        for (const e of (u[keys.AllianceRequest] ?? []) as {
          requestorID: number;
          recipientID: number;
        }[]) {
          if (e.requestorID !== meId && e.recipientID !== meId) continue;
          emit(
            e.recipientID === meId
              ? "alliance_request_received"
              : "alliance_request_sent",
            { from: who(e.requestorID), to: who(e.recipientID) },
          );
        }
        for (const e of (u[keys.AllianceRequestReply] ?? []) as {
          request: { requestorID: number; recipientID: number };
          accepted: boolean;
        }[]) {
          const { requestorID: a, recipientID: b } = e.request;
          if (a !== meId && b !== meId) continue;
          emit(e.accepted ? "alliance_formed" : "alliance_rejected", {
            requestor: who(a),
            recipient: who(b),
          });
        }
        for (const e of (u[keys.BrokeAlliance] ?? []) as {
          traitorID: number;
          betrayedID: number;
        }[]) {
          if (e.traitorID !== meId && e.betrayedID !== meId) continue;
          emit("alliance_broken", {
            traitor: who(e.traitorID),
            betrayed: who(e.betrayedID),
            iBetrayed: e.traitorID === meId,
          });
        }
        for (const e of (u[keys.AllianceExpired] ?? []) as {
          player1ID: number;
          player2ID: number;
        }[]) {
          if (e.player1ID !== meId && e.player2ID !== meId) continue;
          emit("alliance_expired", {
            other: who(e.player1ID === meId ? e.player2ID : e.player1ID),
          });
        }
      }

      // 2b. boats already announced: close to the landing tile, then landed
      for (const [id, st] of boats) {
        const b = game.unit(id);
        if (!b) {
          boats.delete(id);
          continue;
        }
        if (!b.isActive()) {
          emit("transport_ended", {
            unitId: id,
            at: xy(b.tile()),
            troops: b.troops(),
          });
          boats.delete(id);
          continue;
        }
        const t = b.targetTile();
        if (!st.near && t !== undefined) {
          const d = Math.hypot(
            game.x(b.tile()) - game.x(t),
            game.y(b.tile()) - game.y(t),
          );
          if (d <= NEAR_TRANSPORT_TILES) {
            st.near = true;
            emit("transport_near", {
              unitId: id,
              distance: Math.round(d),
              at: xy(b.tile()),
              landing: xy(t),
            });
          }
        }
      }
    } catch {
      // Recording must never disturb the game.
    }
  };
}

function safeStr(f: () => string | undefined): string | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
