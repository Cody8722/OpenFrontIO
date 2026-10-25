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
import { TerraNullius } from "@openfront/engine-api/game/GameTypes";
import {
  buildCandidates,
  CAND_FEATURES,
  r5,
  SELF_FEATURES,
  selfFeatures,
} from "@openfront/engine/execution/utils/AttackFeatures";
import {
  AttackPolicy,
  EngageContext,
  EngageDecision,
  RuleAttackPolicy,
  STRENGTH_STRATEGY_NAMES,
  StrengthContext,
  TurnInfo,
} from "@openfront/engine/execution/utils/AttackPolicy";
import { Game, Player } from "@openfront/engine/game/Game";
import fs from "fs";

export { CAND_FEATURES, SELF_FEATURES };

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
  private pending: string[] = [];

  constructor(
    private game: Game,
    private nationId: string,
    private nationIndex: number,
    private gameKey: string,
    private out: string, // JSONL file, appended to
    private mode: RecorderMode = "full",
  ) {}

  flush(): void {
    if (this.pending.length === 0) return;
    fs.appendFileSync(this.out, this.pending.join("\n") + "\n");
    this.pending = [];
  }

  private me(): Player {
    return this.game.player(this.nationId);
  }

  // ---- AttackPolicy -------------------------------------------------------

  beginTurn(info: TurnInfo): void {
    if (this.mode === "hooks") return;
    const me = this.me();
    this.turn = {
      tick: this.game.ticks(),
      self:
        this.mode === "self" || this.mode === "closure"
          ? []
          : selfFeatures(this.game, me, info.reserveRatio, info.triggerRatio),
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
        : buildCandidates(this.game, me, ctx, this.mode !== "nocr");
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
}
