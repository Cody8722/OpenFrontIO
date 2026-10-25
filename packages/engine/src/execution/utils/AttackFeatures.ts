// The features a nation's attack decision is described by: one set for the
// nation itself, one per candidate target. Shared by the data recorder and the
// network policies, so what was trained on is exactly what runs.
//
// RULE: everything here only reads the game (see AttackPolicy.ts); queries that
// could write a cache go through the StrengthContext, which keeps them quiet.
import {
  GameMode,
  PlayerType,
  Relation,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { log } from "@openfront/engine-lib/DetMath";
import { Game, Player } from "../../game/Game";
import { findRunawayLeader, hasHighStartingGold } from "../nation/NationUtils";
import type { StrengthContext } from "./AttackPolicy";

export const SELF_FEATURES = [
  "troopsRatio", // troops / maxTroops
  "logMaxTroops", // log10(maxTroops)
  "logGold", // log10(1 + gold)
  "logTiles", // log10(1 + tiles)
  "reserveRatio",
  "triggerRatio",
  "overTrigger", // troopsRatio - triggerRatio
  "overReserve", // troopsRatio - reserveRatio
  "incomingRatio", // incoming attack troops / troops
  "incomingCount",
  "outgoingRatio", // outgoing attack troops / troops
  "outgoingCount",
  "nEnemies", // non-friendly neighbours
  "nFriends",
  "logMaxNbrOverMe", // log10((1+strongest non-friendly neighbour) / (1+my troops))
  "logMinNbrOverMe",
  "isFFA",
  "highGold", // rich start (cities don't hold back expansion)
  "tickFrac", // tick / 6000 (10 minutes)
  "iAmLeader", // I am the runaway leader
] as const;

export const CAND_FEATURES = [
  "hostile", // relation <= Hostile
  "relation", // 0 Hostile .. 3 Friendly
  "friendly",
  "allied",
  "isNation",
  "isHuman",
  "isBot",
  "landBorder",
  "logBorderLen", // log10(1 + my border tiles touching them)
  "canReach",
  "theirTroopsRatio", // their troops / their maxTroops
  "logTheirOverMine", // log10((1+their troops) / (1+mine))
  "logTilesRatio", // log10((1+their tiles) / (1+mine))
  "logDensityRatio", // their troops-per-tile over mine, log10
  "theirIncomingRatio", // attack troops incoming on them / their troops
  "isLeader", // runaway leader
  "disconnected",
  "traitor",
  "logNbrCount", // log10(1 + their neighbours)
  "myPressureRatio", // my outgoing troops on them / their troops
  "theirPressureRatio", // their outgoing troops on me / my troops
  "group", // index of the rules' target group (-1: only a hostile relation)
  "inJuicyPool", // troops <= 75% of mine (the juicy candidates)
  "juicyStruct", // log10(1 + structure levels worth capturing)
  "juicyGap", // 1 - troops / maxTroops
  "juicyTiles", // log10(1 + tiles)
  "juicyStructNorm", // the rules' min-max normalisation inside the pool
  "juicyGapNorm",
  "juicyTilesNorm",
  "juicyScore", // sum of the three normalised parts
  "islandRank", // 1/2: nearest / second nearest reachable (the island rule's picks), 0: neither
] as const;

/** Rounds to 5 decimals, the precision the training data was kept at. */
export const r5 = (x: number): number =>
  Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : 0;
const log10 = (x: number): number => log(x) / Math.LN10;
const lg = (x: number): number => log10(1 + Math.max(0, x));
const lgRatio = (a: number, b: number): number =>
  log10((1 + Math.max(0, a)) / (1 + Math.max(0, b)));

export function selfFeatures(
  game: Game,
  me: Player,
  reserveRatio: number,
  triggerRatio: number,
): number[] {
  const cfg = game.config();
  const troops = me.troops();
  const max = cfg.maxTroops(me);
  const incoming = me.incomingAttacks();
  const outgoing = me.outgoingAttacks();
  const inSum = incoming.reduce((a, x) => a + x.troops(), 0);
  const outSum = outgoing.reduce((a, x) => a + x.troops(), 0);
  let enemies = 0;
  let friends = 0;
  let maxNbr = 0;
  let minNbr = Infinity;
  for (const n of me.nearby()) {
    if (!n.isPlayer()) continue;
    if (me.isFriendly(n)) {
      friends++;
      continue;
    }
    enemies++;
    if (n.type() !== PlayerType.Bot) {
      maxNbr = Math.max(maxNbr, n.troops());
      minNbr = Math.min(minNbr, n.troops());
    }
  }
  if (!Number.isFinite(minNbr)) minNbr = 0;
  const tr = troops / max;
  return [
    tr,
    log10(max),
    lg(Number(me.gold())),
    lg(me.numTilesOwned()),
    reserveRatio,
    triggerRatio,
    tr - triggerRatio,
    tr - reserveRatio,
    inSum / Math.max(1, troops),
    incoming.length,
    outSum / Math.max(1, troops),
    outgoing.length,
    enemies,
    friends,
    lgRatio(maxNbr, troops),
    lgRatio(minNbr, troops),
    cfg.gameConfig().gameMode === GameMode.FFA ? 1 : 0,
    hasHighStartingGold(game, me) ? 1 : 0,
    game.ticks() / 6000,
    findRunawayLeader(game) === me ? 1 : 0,
  ].map(r5);
}

/**
 * Every player any of the seven strength rules may attack this turn: the
 * rules' target groups, the hostile non-friendly players (hated) and the
 * island rule's two nearest, with one feature row each. `reach: false` skips
 * the queries that need the planned-route machinery (debugging only).
 */
export function buildCandidates(
  game: Game,
  me: Player,
  ctx: StrengthContext,
  reach = true,
): { list: Player[]; rows: number[][] } {
  const cfg = game.config();
  const groupOf = new Map<Player, number>();
  ctx.groups().forEach((grp, i) => {
    for (const p of grp) if (!groupOf.has(p)) groupOf.set(p, i);
  });
  const list: Player[] = [...groupOf.keys()];
  for (const { player, relation } of me.allRelationsSorted()) {
    if (
      relation === Relation.Hostile &&
      !me.isFriendly(player) &&
      !groupOf.has(player) &&
      player.isAlive()
    ) {
      groupOf.set(player, -1);
      list.push(player);
    }
  }
  // The island rule picks outside both groups and relations
  const island = reach ? ctx.islandCandidates() : [];
  for (const player of island) {
    if (!groupOf.has(player)) {
      groupOf.set(player, -1);
      list.push(player);
    }
  }

  // my border tiles touching each player
  const borderLen = new Map<Player, number>();
  me.borderTiles().forEach((tile) => {
    game.forEachNeighbor(tile, (nt) => {
      const id = game.ownerID(nt);
      if (id === me.smallID()) return;
      const o = game.playerBySmallID(id);
      if (o.isPlayer()) borderLen.set(o, (borderLen.get(o) ?? 0) + 1);
    });
  });

  const myTroops = me.troops();
  const myTiles = me.numTilesOwned();
  const leader = findRunawayLeader(game);
  const outTo = (p: Player) =>
    me
      .outgoingAttacks()
      .filter((a) => a.target() === p)
      .reduce((s, a) => s + a.troops(), 0);
  const inFrom = (p: Player) =>
    me
      .incomingAttacks()
      .filter((a) => a.attacker() === p)
      .reduce((s, a) => s + a.troops(), 0);

  // the rules' juicy score (NationUtils.findJuiciestTarget) inside its pool
  const inPool = list.filter((p) => p.troops() <= myTroops * 0.75);
  const part = (p: Player) => {
    const struct = p
      .units()
      .reduce(
        (sum, u) =>
          Structures.has(u.type()) &&
          u.type() !== UnitType.DefensePost &&
          u.type() !== UnitType.MissileSilo
            ? sum + u.level()
            : sum,
        0,
      );
    const max = cfg.maxTroops(p);
    return {
      struct,
      gap: max > 0 ? 1 - p.troops() / max : 0,
      tiles: p.numTilesOwned(),
    };
  };
  const parts = new Map<Player, ReturnType<typeof part>>();
  for (const p of list) parts.set(p, part(p));
  const norm = (v: number, vs: number[]) => {
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    return hi > lo ? (v - lo) / (hi - lo) : 0;
  };
  const poolStruct = inPool.map((p) => parts.get(p)!.struct);
  const poolGap = inPool.map((p) => parts.get(p)!.gap);
  const poolTiles = inPool.map((p) => parts.get(p)!.tiles);

  const rows = list.map((p) => {
    const pt = parts.get(p)!;
    const pooled = inPool.includes(p);
    const sN = pooled ? norm(pt.struct, poolStruct) : 0;
    const gN = pooled ? norm(pt.gap, poolGap) : 0;
    const tN = pooled ? norm(pt.tiles, poolTiles) : 0;
    const rel = me.relation(p);
    const pMax = cfg.maxTroops(p);
    const pTroops = p.troops();
    const pTiles = p.numTilesOwned();
    const theirInc = p.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
    return [
      rel <= Relation.Hostile ? 1 : 0,
      rel,
      me.isFriendly(p) ? 1 : 0,
      me.isAlliedWith(p) ? 1 : 0,
      p.type() === PlayerType.Nation ? 1 : 0,
      p.type() === PlayerType.Human ? 1 : 0,
      p.type() === PlayerType.Bot ? 1 : 0,
      me.sharesBorderWith(p) ? 1 : 0,
      lg(borderLen.get(p) ?? 0),
      reach && ctx.canReach(p) ? 1 : 0,
      pMax > 0 ? pTroops / pMax : 0,
      lgRatio(pTroops, myTroops),
      lgRatio(pTiles, myTiles),
      log10(
        (1 + pTroops / Math.max(1, pTiles)) /
          (1 + myTroops / Math.max(1, myTiles)),
      ),
      theirInc / Math.max(1, pTroops),
      leader === p ? 1 : 0,
      p.isDisconnected() ? 1 : 0,
      p.isTraitor() ? 1 : 0,
      lg(p.nearby().length),
      outTo(p) / Math.max(1, pTroops),
      inFrom(p) / Math.max(1, myTroops),
      groupOf.get(p) ?? -1,
      pooled ? 1 : 0,
      lg(pt.struct),
      pt.gap,
      lg(pt.tiles),
      sN,
      gN,
      tN,
      sN + gN + tN,
      island.indexOf(p) + 1,
    ].map(r5);
  });
  return { list, rows };
}
