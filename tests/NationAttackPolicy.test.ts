import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import {
  AttackPolicy,
  RULE_ATTACK_POLICY,
  RuleAttackPolicy,
} from "@openfront/engine/execution/utils/AttackPolicy";
import { TraceSpec, traceWorld } from "./util/NationTrace";

const SPEC: TraceSpec = {
  label: "policy",
  gameID: "nn-seed-a",
  difficulty: Difficulty.Hard,
  nations: 25,
  ticks: 1500,
};

const run = async (policy?: AttackPolicy, spec: TraceSpec = SPEC) =>
  (await traceWorld(spec, undefined, undefined, policy)).result;

// Rules for engage, strength block in reverse order
const reversed: AttackPolicy = {
  engage: (ctx) => RULE_ATTACK_POLICY.engage(ctx),
  strengthStrategies: (ctx) =>
    new RuleAttackPolicy().strengthStrategies(ctx).reverse(),
};

// Rules for engage; the weakest reachable target, with half the base troops
const halfWeakest: AttackPolicy = {
  engage: (ctx) => RULE_ATTACK_POLICY.engage(ctx),
  strengthStrategies: (ctx) => [
    () => {
      for (const group of ctx.groups()) {
        const target = group.find((p) => ctx.canReach(p));
        if (target !== undefined) return ctx.attack(target, 0.5);
      }
      return false;
    },
  ],
};

const neverEngage: AttackPolicy = {
  engage: () => "hold",
  strengthStrategies: (ctx) => new RuleAttackPolicy().strengthStrategies(ctx),
};

describe("nation attack policy", () => {
  test("the rule policy passed explicitly equals the default", async () => {
    const a = await run();
    const b = await run(new RuleAttackPolicy());
    expect(b.chain).toBe(a.chain);
    expect(b.attacksStarted).toBe(a.attacksStarted);
  }, 120_000);

  test("a different strategy order changes the game, deterministically", async () => {
    const base = await run();
    const r1 = await run(reversed);
    const r2 = await run(reversed);
    expect(r1.chain).not.toBe(base.chain);
    expect(r2.chain).toBe(r1.chain);
    expect(r2.checkpoints).toEqual(r1.checkpoints);
  }, 120_000);

  test("a troop fraction policy changes the game, deterministically", async () => {
    const base = await run();
    const r1 = await run(halfWeakest);
    const r2 = await run(halfWeakest);
    expect(r1.chain).not.toBe(base.chain);
    expect(r2.chain).toBe(r1.chain);
    expect(r1.attacksStarted).toBeGreaterThan(0);
  }, 120_000);

  test("engage can hold every attack turn", async () => {
    const base = await run();
    const held = await run(neverEngage);
    // Bot, retaliation and annexation attacks run before the engage decision
    expect(held.attacksStarted).toBeLessThan(base.attacksStarted);
    expect((await run(neverEngage)).chain).toBe(held.chain);
  }, 120_000);
});
