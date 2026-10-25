import type { TerraNullius } from "@openfront/engine-api/game/GameTypes";
import { Player } from "../../game/Game";

/**
 * The swappable decisions of a nation's attack choice (the chooseAttack path
 * of AiAttackBehavior). RuleAttackPolicy is the original rule set; every
 * method must leave the nation's shared PRNG exactly as the rules would, or
 * games stop replaying tick for tick.
 *
 * RULE: any query made while deciding must not change the game state. That
 * covers everything on the contexts (canReach, groups, ...) and everything a
 * policy reads from the game itself: no PRNG draws, no cache writes the rules
 * later act on, no spawned executions. A policy may look at as many players as
 * it likes; the game must still play exactly as if it had not looked.
 * tests/NationPolicyGuard.test.ts enforces this; any policy (a network too)
 * must pass it.
 */

/** Result of the engage decision: "hold" and "acted" both end the attack turn. */
export type EngageDecision = "hold" | "attack" | "acted";

export interface EngageContext {
  troops: number;
  maxTroops: number;
  reserveRatio: number;
  triggerRatio: number;
  /** troops / maxTroops >= reserveRatio */
  hasReserve: boolean;
  /** troops / maxTroops >= triggerRatio */
  hasTrigger: boolean;
  /** The rules' 1-in-10 pass when the trigger ratio is not reached; draws from the PRNG. */
  chance10(): boolean;
  /** Medium retaliates between the two checks; null for the other difficulties. */
  beforeTrigger: (() => boolean) | null;
}

/** The strength-based target strategies, in the rules' Hard order. */
export const STRENGTH_STRATEGY_NAMES = [
  "hated",
  "veryWeak",
  "juicy",
  "victim",
  "crown",
  "weakest",
  "island",
] as const;
export type StrengthStrategyName = (typeof STRENGTH_STRATEGY_NAMES)[number];

export interface StrengthContext {
  /** The rules' own strategies; each returns true if it sent an attack. */
  rules: Record<StrengthStrategyName, () => boolean>;
  /** Target groups the rules try in order, each sorted by troops (ascending). */
  groups(): Player[][];
  /** Whether a land or boat attack on target is possible right now; free of side effects. */
  canReach(target: Player): boolean;
  /**
   * Attacks target with fraction (0..1) of the rules' base amount; the
   * safety caps (troopSendCap, too-weak check) still apply afterwards.
   * Returns true if an attack was sent.
   */
  attack(target: Player, fraction: number): boolean;
}

export interface AttackPolicy {
  /** Optional observers, for recording data; they must not touch the game or the PRNG. */
  beginTurn?(): void;
  /** An attack or transport ship left: land attacks and boats, in the order sent. */
  attackSent?(
    target: Player | TerraNullius,
    troops: number,
    kind: "land" | "boat",
  ): void;
  endTurn?(): void;

  /** Decision 1: attack this turn or not (reserve + trigger ratio checks). */
  engage(ctx: EngageContext): EngageDecision;
  /**
   * Decisions 2 and 3: the strategies replacing the strength-based block of
   * the Hard order. They are tried in order; the first to return true ends
   * the turn. Targets are sent through ctx.attack, which carries the troop
   * fraction.
   */
  strengthStrategies(ctx: StrengthContext): Array<() => boolean>;
}

export class RuleAttackPolicy implements AttackPolicy {
  engage(ctx: EngageContext): EngageDecision {
    // Save up troops until we reach the reserve ratio
    if (!ctx.hasReserve) return "hold";
    if (ctx.beforeTrigger !== null && ctx.beforeTrigger()) return "acted";
    // Maybe save up troops until we reach the trigger ratio
    if (!ctx.hasTrigger && !ctx.chance10()) return "hold";
    return "attack";
  }

  strengthStrategies(ctx: StrengthContext): Array<() => boolean> {
    return STRENGTH_STRATEGY_NAMES.map((name) => ctx.rules[name]);
  }
}

export const RULE_ATTACK_POLICY: AttackPolicy = new RuleAttackPolicy();
