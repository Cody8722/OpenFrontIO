import type { TerraNullius } from "@openfront/engine-api/game/GameTypes";
import { Game, Player } from "../../game/Game";
import { buildCandidates, selfFeatures } from "./AttackFeatures";
import { argmax, attackNetLogits, AttackNetWeights } from "./AttackNet";
import { ATTACK_NET_WEIGHTS } from "./AttackNetWeights";
import {
  AttackPolicy,
  EngageContext,
  EngageDecision,
  RuleAttackPolicy,
  STRENGTH_STRATEGY_NAMES,
  StrengthContext,
  TurnInfo,
} from "./AttackPolicy";

/**
 * What the network would have chosen next to what the rules did, at one
 * decision of the strength-based block. Labels count like the training data:
 * 0 = no attack, k + 1 = candidate k.
 */
export interface ShadowRecord {
  tick: number;
  /** The rule that attacked, null if every rule refused. */
  rule: string | null;
  candidates: number;
  /** The network's pick; -1 when there was no candidate to score. */
  net: number;
  /** The rules' pick; -1 if they attacked someone outside the candidates. */
  picked: number;
}

/**
 * Shadow mode: the rules play exactly as without it and the network scores the
 * same decision, recorded to the sink and never executed. It adds no random
 * draws and only runs queries that leave the game untouched (AttackPolicy.ts).
 */
export class NetworkShadowPolicy implements AttackPolicy {
  private rules = new RuleAttackPolicy();
  private info: TurnInfo | null = null;
  private tick = 0;
  private self: number[] = [];
  private inStrength = false;
  private sent: (Player | TerraNullius)[] = [];

  constructor(
    private game: Game,
    private nationId: string,
    private sink: (record: ShadowRecord) => void,
    private weights: AttackNetWeights = ATTACK_NET_WEIGHTS,
  ) {}

  beginTurn(info: TurnInfo): void {
    this.info = info;
    this.tick = this.game.ticks();
    // read now, as the recorder does: earlier rules may act before the strength block
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

  attackSent(target: Player | TerraNullius): void {
    if (this.inStrength) this.sent.push(target);
  }

  engage(ctx: EngageContext): EngageDecision {
    return this.rules.engage(ctx);
  }

  strengthStrategies(ctx: StrengthContext): Array<() => boolean> {
    // One closure running the seven rules in their order, as the recorder does
    return [() => this.run(ctx)];
  }

  private run(ctx: StrengthContext): boolean {
    if (this.info === null) {
      return this.rules.strengthStrategies(ctx).some((s) => s());
    }
    const me = this.game.player(this.nationId);
    const cands = buildCandidates(this.game, me, ctx);
    const net =
      cands.list.length === 0
        ? -1
        : argmax(attackNetLogits(this.weights, this.self, cands.rows));

    this.sent = [];
    this.inStrength = true;
    let rule: string | null = null;
    try {
      for (const name of STRENGTH_STRATEGY_NAMES) {
        if (ctx.rules[name]()) {
          rule = name;
          break;
        }
      }
    } finally {
      this.inStrength = false;
    }
    const last = this.sent[this.sent.length - 1];
    const index = cands.list.findIndex((p) => p === last);
    this.sink({
      tick: this.tick,
      rule,
      candidates: cands.list.length,
      net,
      picked: rule === null ? 0 : index >= 0 ? index + 1 : -1,
    });
    return rule !== null;
  }
}
