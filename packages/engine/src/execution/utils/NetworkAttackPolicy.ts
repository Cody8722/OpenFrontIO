import type { TerraNullius } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../../game/Game";
import { buildCandidates, selfFeatures } from "./AttackFeatures";
import { attackNetLogits, AttackNetWeights } from "./AttackNet";
import { ATTACK_NET_WEIGHTS } from "./AttackNetWeights";
import {
  AttackPolicy,
  EngageContext,
  EngageDecision,
  RuleAttackPolicy,
  StrengthContext,
  TurnInfo,
} from "./AttackPolicy";

/** Counts of what the network did; the caller owns the object and may share it. */
export interface TakeoverStats {
  /** Strength-block decisions that had at least one candidate. */
  decisions: number;
  /** Decisions with no candidate: nothing to attack. */
  noCandidates: number;
  /** The network ranked "no attack" first. */
  netNone: number;
  /** The network ranked a candidate above "no attack". */
  netAttack: number;
  /** "No attack" answers handed to the rules' crown strategy, and how often it attacked. */
  crownTried: number;
  crownFired: number;
  /** Ranked attacks that were refused (too weak, no route...) and the next was tried. */
  sendFailed: number;
  /** Decisions where every ranked attack was refused. */
  allFailed: number;
}

export const newTakeoverStats = (): TakeoverStats => ({
  decisions: 0,
  noCandidates: 0,
  netNone: 0,
  netAttack: 0,
  crownTried: 0,
  crownFired: 0,
  sendFailed: 0,
  allFailed: 0,
});

/**
 * The network picks the target of the strength-based block; the rest of the
 * attack turn (engage, bots, assist, betray, traitor, afk, donate, retaliation)
 * stays with the rules. Candidates scoring above "no attack" are tried best
 * first until one attack is sent; when the network answers "no attack" the
 * rules' crown strategy gets the turn. It draws no random numbers, so the same
 * seed replays tick for tick, and its queries leave the game untouched.
 */
export class NetworkAttackPolicy implements AttackPolicy {
  private rules = new RuleAttackPolicy();
  private info: TurnInfo | null = null;
  private self: number[] = [];

  constructor(
    private game: Game,
    private nationId: string,
    private stats: TakeoverStats,
    private weights: AttackNetWeights = ATTACK_NET_WEIGHTS,
  ) {}

  beginTurn(info: TurnInfo): void {
    this.info = info;
    // read now, as when the network was trained: earlier rules may act first
    this.self = selfFeatures(
      this.game,
      this.game.player(this.nationId),
      info.reserveRatio,
      info.triggerRatio,
    );
  }

  endTurn(): void {
    this.info = null;
  }

  attackSent(_target: Player | TerraNullius): void {
    // nothing to observe: the attacks are the network's own
  }

  engage(ctx: EngageContext): EngageDecision {
    return this.rules.engage(ctx);
  }

  strengthStrategies(ctx: StrengthContext): Array<() => boolean> {
    return [() => this.decide(ctx)];
  }

  private decide(ctx: StrengthContext): boolean {
    if (this.info === null) {
      return this.rules.strengthStrategies(ctx).some((s) => s());
    }
    const me = this.game.player(this.nationId);
    const cands = buildCandidates(this.game, me, ctx);
    if (cands.list.length === 0) {
      this.stats.noCandidates++;
      return false;
    }
    this.stats.decisions++;
    const logits = attackNetLogits(this.weights, this.self, cands.rows);

    // candidates scoring strictly above "no attack", best first (ties: earlier)
    const taken = new Array<boolean>(cands.list.length).fill(false);
    const ranked: number[] = [];
    for (;;) {
      let best = -1;
      for (let k = 0; k < cands.list.length; k++) {
        if (taken[k] || !(logits[k + 1] > logits[0])) continue;
        if (best === -1 || logits[k + 1] > logits[best + 1]) best = k;
      }
      if (best === -1) break;
      taken[best] = true;
      ranked.push(best);
    }

    if (ranked.length === 0) {
      this.stats.netNone++;
      this.stats.crownTried++;
      if (ctx.rules.crown()) {
        this.stats.crownFired++;
        return true;
      }
      return false;
    }
    this.stats.netAttack++;
    for (const k of ranked) {
      if (ctx.attack(cands.list[k], 1)) return true;
      this.stats.sendFailed++;
    }
    this.stats.allFailed++;
    return false;
  }
}
