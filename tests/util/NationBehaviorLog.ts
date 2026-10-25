// Wraps an attack policy and logs what it does, without changing it: every
// attack sent (when, what kind, at whom) and every attack turn (for the wave
// intervals). It only calls pure queries on the game (AttackPolicy.ts RULE), and
// wraps the strength block in one closure like the recorder, which is proven to
// play the same game as the plain list.
import { Relation, TerraNullius } from "@openfront/engine-api/game/GameTypes";
import { findRunawayLeader } from "@openfront/engine/execution/nation/NationUtils";
import {
  AttackPolicy,
  EngageContext,
  EngageDecision,
  StrengthContext,
  TurnInfo,
} from "@openfront/engine/execution/utils/AttackPolicy";
import { Game, Player } from "@openfront/engine/game/Game";

export interface SendLog {
  n: number; // nation index
  k: number; // tick
  kind: "land" | "boat";
  strength: boolean; // sent by the strength-based block
  target: "tn" | "player";
  border: boolean; // shares a border with us
  hostile: boolean; // our relation to them is hostile
  leader: boolean; // the runaway leader
  logRatio: number; // log10(their troops / ours)
}

export interface TurnLog {
  n: number;
  k: number;
  sent: number; // attacks sent this turn, any path
}

export interface StrengthCounts {
  decisions: number; // strength blocks reached
  attacks: number; // of those, ended in an attack
}

export class BehaviorLog implements AttackPolicy {
  private tick = 0;
  private sent = 0;
  private inStrength = false;

  constructor(
    private inner: AttackPolicy,
    private game: Game,
    private nationId: string,
    private n: number,
    private sends: SendLog[],
    private turns: TurnLog[],
    private strength: StrengthCounts,
  ) {}

  beginTurn(info: TurnInfo): void {
    this.tick = this.game.ticks();
    this.sent = 0;
    this.inner.beginTurn?.(info);
  }

  endTurn(): void {
    this.inner.endTurn?.();
    this.turns.push({ n: this.n, k: this.tick, sent: this.sent });
  }

  attackSent(
    target: Player | TerraNullius,
    troops: number,
    kind: "land" | "boat",
  ): void {
    this.sent++;
    const me = this.game.player(this.nationId);
    const isPlayer = target.isPlayer();
    this.sends.push({
      n: this.n,
      k: this.tick,
      kind,
      strength: this.inStrength,
      target: isPlayer ? "player" : "tn",
      border: isPlayer && me.sharesBorderWith(target),
      hostile: isPlayer && me.relation(target) <= Relation.Hostile,
      leader: isPlayer && findRunawayLeader(this.game) === target,
      logRatio: isPlayer
        ? Math.round(
            1e3 * Math.log10((1 + target.troops()) / (1 + me.troops())),
          ) / 1e3
        : 0,
    });
    this.inner.attackSent?.(target, troops, kind);
  }

  engage(ctx: EngageContext): EngageDecision {
    return this.inner.engage(ctx);
  }

  strengthStrategies(ctx: StrengthContext): Array<() => boolean> {
    const list = this.inner.strengthStrategies(ctx);
    return [
      () => {
        this.strength.decisions++;
        this.inStrength = true;
        try {
          const done = list.some((s) => s());
          if (done) this.strength.attacks++;
          return done;
        } finally {
          this.inStrength = false;
        }
      },
    ];
  }
}
