// Wraps an attack policy and logs what it does, without changing it: every
// attack sent (when, what kind, at whom) and every attack turn (for the wave
// intervals). It only calls pure queries on the game (AttackPolicy.ts RULE), and
// wraps the strength block in one closure like the recorder, which is proven to
// play the same game as the plain list.
import { Relation, TerraNullius } from "@openfront/engine-api/game/GameTypes";
import { findRunawayLeader } from "@openfront/engine/execution/nation/NationUtils";
import { AiAttackBehavior } from "@openfront/engine/execution/utils/AiAttackBehavior";
import { buildCandidates } from "@openfront/engine/execution/utils/AttackFeatures";
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

/** One strength-block decision, for the consistency measures. */
export interface DecisionLog {
  n: number;
  k: number;
  c: number[]; // candidate small ids, ascending
  ch: number; // small id of the player attacked, -1 if none
  fail: number; // sendAttack calls refused inside the block
  atk: boolean; // the block ended in an attack
  tr: number; // troops / max troops
}

/**
 * Counts sendAttack calls refused while a strength block runs (the rules call
 * it per rule, the network per ranked candidate). The wrapper returns what the
 * original returns, so it changes nothing.
 */
export const sendProbe = { inStrength: false, fails: 0, installed: false };

export function installSendProbe(): void {
  if (sendProbe.installed) return;
  sendProbe.installed = true;
  const proto = AiAttackBehavior.prototype as unknown as {
    sendAttack(this: unknown, ...args: unknown[]): boolean;
  };
  const original = proto.sendAttack;
  proto.sendAttack = function (this: unknown, ...args: unknown[]): boolean {
    const ok = original.apply(this, args);
    if (!ok && sendProbe.inStrength) sendProbe.fails++;
    return ok;
  };
}

export class BehaviorLog implements AttackPolicy {
  private tick = 0;
  private sent = 0;
  private inStrength = false;
  private last = -1;

  constructor(
    private inner: AttackPolicy,
    private game: Game,
    private nationId: string,
    private n: number,
    private sends: SendLog[],
    private turns: TurnLog[],
    private strength: StrengthCounts,
    private decisions?: DecisionLog[],
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
    if (this.inStrength && isPlayer) this.last = target.smallID();
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
        let cands: number[] = [];
        let tr = 0;
        if (this.decisions !== undefined) {
          const me = this.game.player(this.nationId);
          cands = buildCandidates(this.game, me, ctx)
            .list.map((p) => p.smallID())
            .sort((a, b) => a - b);
          tr = me.troops() / this.game.config().maxTroops(me);
        }
        const failsBefore = sendProbe.fails;
        this.last = -1;
        this.inStrength = true;
        sendProbe.inStrength = true;
        try {
          const done = list.some((s) => s());
          if (done) this.strength.attacks++;
          this.decisions?.push({
            n: this.n,
            k: this.tick,
            c: cands,
            ch: done ? this.last : -1,
            fail: sendProbe.fails - failsBefore,
            atk: done,
            tr: Math.round(tr * 1e3) / 1e3,
          });
          return done;
        } finally {
          this.inStrength = false;
          sendProbe.inStrength = false;
        }
      },
    ];
  }
}
