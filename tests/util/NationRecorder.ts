// RULE: any query made while deciding must not change the game state (no PRNG
// draws, no cache writes the rules later act on). See AttackPolicy.ts and
// tests/NationPolicyGuard.test.ts.
//
// Records the rule policy's decisions as JSONL, without changing them: the
// recorder only observes (the collect test proves a recorded game replays the
// unrecorded one tick for tick).
//
// Two row kinds, field order in SCHEMA below:
//   "e" engage: one per attack turn of a nation, whether or not the engage
//        decision was reached (rules like retaliation or the terra nullius
//        attack can act first)
//   "t" target: one per turn that reached the strength-based block, with every
//        candidate target's features and which one the rules attacked
import {
  GameMode,
  PlayerType,
  Relation,
  Structures,
  TerraNullius,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import {
  findRunawayLeader,
  hasHighStartingGold,
} from "@openfront/engine/execution/nation/NationUtils";
import {
  AttackPolicy,
  EngageContext,
  EngageDecision,
  RuleAttackPolicy,
  STRENGTH_STRATEGY_NAMES,
  StrengthContext,
} from "@openfront/engine/execution/utils/AttackPolicy";
import { Game, Player } from "@openfront/engine/game/Game";
import fs from "fs";

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

export const SCHEMA = {
  self: SELF_FEATURES,
  cand: CAND_FEATURES,
  strategies: STRENGTH_STRATEGY_NAMES,
  rows: {
    e: "{t,g:gameID,n:nation,k:tick,s:selfFeatures,reached,hasReserve,hasTrigger,c10Called,c10Pass,decision,pre:[sent before engage],post:[sent after engage]}",
    t: "{t,g,n,k,s,c:[candidate feature arrays],y:chosen index or -1,rule,none,out:chosen not among candidates,sent}",
  },
  sent: "[kind land|boat, target tn|bot|nation|human, troops/maxTroops]",
};

type Sent = [string, string, number];

interface Turn {
  tick: number;
  self: number[];
  reached: boolean;
  hasReserve: boolean;
  hasTrigger: boolean;
  c10Called: boolean;
  c10Pass: boolean;
  decision: EngageDecision | null;
  pre: Sent[];
  post: Sent[];
  inStrength: boolean;
  strengthSent: { target: Player | TerraNullius; s: Sent }[];
}

const r5 = (x: number): number =>
  Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : 0;
const lg = (x: number): number => Math.log10(1 + Math.max(0, x));
const lgRatio = (a: number, b: number): number =>
  Math.log10((1 + Math.max(0, a)) / (1 + Math.max(0, b)));

// Debug switch to find what perturbs a game: hooks < self < closure < cands < nocr < full
export type RecorderMode =
  | "hooks"
  | "self"
  | "closure"
  | "cands"
  | "nocr"
  | "full";

export class DecisionRecorder implements AttackPolicy {
  private rules = new RuleAttackPolicy();
  private turn: Turn | null = null;
  private triggerRatio: number;
  private reserveRatio: number;
  private ratiosChecked = false;
  private pending: string[] = [];

  constructor(
    private game: Game,
    private nationId: string,
    private nationIndex: number,
    private gameKey: string,
    private out: string, // JSONL file, appended to
    private mode: RecorderMode = "full",
  ) {
    // The nation's own draws (NationExecution's constructor): trigger, then reserve
    const r = new PseudoRandom(simpleHash(nationId) + simpleHash(gameKey));
    this.triggerRatio = r.nextInt(50, 60) / 100;
    this.reserveRatio = r.nextInt(30, 40) / 100;
  }

  flush(): void {
    if (this.pending.length === 0) return;
    fs.appendFileSync(this.out, this.pending.join("\n") + "\n");
    this.pending = [];
  }

  private me(): Player {
    return this.game.player(this.nationId);
  }

  // ---- AttackPolicy -------------------------------------------------------

  beginTurn(): void {
    if (this.mode === "hooks") return;
    const me = this.me();
    this.turn = {
      tick: this.game.ticks(),
      self:
        this.mode === "self" || this.mode === "closure"
          ? []
          : this.selfFeatures(me),
      reached: false,
      hasReserve: false,
      hasTrigger: false,
      c10Called: false,
      c10Pass: false,
      decision: null,
      pre: [],
      post: [],
      inStrength: false,
      strengthSent: [],
    };
  }

  endTurn(): void {
    const t = this.turn;
    if (t === null) return;
    this.turn = null;
    this.pending.push(
      JSON.stringify({
        t: "e",
        g: this.gameKey,
        n: this.nationIndex,
        k: t.tick,
        s: t.self,
        reached: t.reached,
        hasReserve: t.hasReserve,
        hasTrigger: t.hasTrigger,
        c10Called: t.c10Called,
        c10Pass: t.c10Pass,
        decision: t.decision,
        pre: t.pre,
        post: t.post,
      }),
    );
    if (this.pending.length >= 200) this.flush();
  }

  attackSent(
    target: Player | TerraNullius,
    troops: number,
    kind: "land" | "boat",
  ): void {
    const t = this.turn;
    if (t === null) return; // e.g. a forced first attack, outside a turn
    const max = this.game.config().maxTroops(this.me());
    const tt = target.isPlayer() ? target.type().toLowerCase() : "tn";
    const s: Sent = [kind, tt, r5(troops / max)];
    if (t.inStrength) t.strengthSent.push({ target, s });
    else if (t.reached) t.post.push(s);
    else t.pre.push(s);
  }

  engage(ctx: EngageContext): EngageDecision {
    const t = this.turn;
    if (t === null) return this.rules.engage(ctx);
    if (!this.ratiosChecked) {
      this.ratiosChecked = true;
      if (
        ctx.triggerRatio !== this.triggerRatio ||
        ctx.reserveRatio !== this.reserveRatio
      ) {
        throw new Error(
          `ratio replay mismatch: ${ctx.triggerRatio}/${ctx.reserveRatio} vs ${this.triggerRatio}/${this.reserveRatio}`,
        );
      }
    }
    t.reached = true;
    t.hasReserve = ctx.hasReserve;
    t.hasTrigger = ctx.hasTrigger;
    const wrapped: EngageContext = {
      ...ctx,
      chance10: () => {
        const pass = ctx.chance10();
        t.c10Called = true;
        t.c10Pass = pass;
        return pass;
      },
    };
    t.decision = this.rules.engage(wrapped);
    return t.decision;
  }

  strengthStrategies(ctx: StrengthContext): Array<() => boolean> {
    if (this.mode === "hooks") return this.rules.strengthStrategies(ctx);
    // One closure running the seven rules in their order: same calls, same
    // order, same result as the plain list. Features are read when it starts,
    // i.e. after the earlier rules found nothing.
    return [() => this.runStrength(ctx)];
  }

  // ---- strength block -----------------------------------------------------

  private runStrength(ctx: StrengthContext): boolean {
    const t = this.turn;
    if (t === null) {
      return this.rules.strengthStrategies(ctx).some((s) => s());
    }
    const me = this.me();
    const cands =
      this.mode === "closure"
        ? { list: [] as Player[], rows: [] as number[][] }
        : this.candidates(me, ctx);
    t.inStrength = true;
    let rule: string | null = null;
    try {
      for (const name of STRENGTH_STRATEGY_NAMES) {
        if (ctx.rules[name]()) {
          rule = name;
          break;
        }
      }
    } finally {
      t.inStrength = false;
    }
    const last = t.strengthSent[t.strengthSent.length - 1];
    let y = -1;
    if (last !== undefined) {
      y = cands.list.findIndex((p) => p === last.target);
    }
    this.pending.push(
      JSON.stringify({
        t: "t",
        g: this.gameKey,
        n: this.nationIndex,
        k: t.tick,
        s: t.self,
        c: cands.rows,
        y,
        rule,
        none: rule === null,
        out: last !== undefined && y === -1,
        sent: t.strengthSent.map((x) => x.s),
      }),
    );
    return rule !== null;
  }

  // ---- features -----------------------------------------------------------

  private selfFeatures(me: Player): number[] {
    const g = this.game;
    const cfg = g.config();
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
      Math.log10(max),
      lg(Number(me.gold())),
      lg(me.numTilesOwned()),
      this.reserveRatio,
      this.triggerRatio,
      tr - this.triggerRatio,
      tr - this.reserveRatio,
      inSum / Math.max(1, troops),
      incoming.length,
      outSum / Math.max(1, troops),
      outgoing.length,
      enemies,
      friends,
      lgRatio(maxNbr, troops),
      lgRatio(minNbr, troops),
      cfg.gameConfig().gameMode === GameMode.FFA ? 1 : 0,
      hasHighStartingGold(g, me) ? 1 : 0,
      g.ticks() / 6000,
      findRunawayLeader(g) === me ? 1 : 0,
    ].map(r5);
  }

  private candidates(
    me: Player,
    ctx: StrengthContext,
  ): { list: Player[]; rows: number[][] } {
    const g = this.game;
    const cfg = g.config();
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
    const island = this.mode === "nocr" ? [] : ctx.islandCandidates();
    for (const player of island) {
      if (!groupOf.has(player)) {
        groupOf.set(player, -1);
        list.push(player);
      }
    }

    // my border tiles touching each player
    const borderLen = new Map<Player, number>();
    me.borderTiles().forEach((tile) => {
      g.forEachNeighbor(tile, (nt) => {
        const id = g.ownerID(nt);
        if (id === me.smallID()) return;
        const o = g.playerBySmallID(id);
        if (o.isPlayer()) borderLen.set(o, (borderLen.get(o) ?? 0) + 1);
      });
    });

    const myTroops = me.troops();
    const myTiles = me.numTilesOwned();
    const leader = findRunawayLeader(g);
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
        this.mode !== "nocr" && ctx.canReach(p) ? 1 : 0,
        pMax > 0 ? pTroops / pMax : 0,
        lgRatio(pTroops, myTroops),
        lgRatio(pTiles, myTiles),
        Math.log10(
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
}
