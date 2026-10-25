// Guards the policy rule: any query made while deciding must not change the
// game state. A policy (the rules, a recorder, later a network) is run next to
// the same policy wrapped in a probe that asks every query it can about every
// player; the two games must have the same tick-level hash chain.
import { Difficulty, Nation } from "@openfront/engine-api/game/GameTypes";
import { AiAttackBehavior } from "@openfront/engine/execution/utils/AiAttackBehavior";
import {
  AttackPolicy,
  RuleAttackPolicy,
} from "@openfront/engine/execution/utils/AttackPolicy";
import { Game } from "@openfront/engine/game/Game";
import os from "os";
import { DecisionRecorder } from "./util/NationRecorder";
import { TraceSpec, traceWorld } from "./util/NationTrace";

const TICKS = Number(process.env.NN_GUARD_TICKS ?? 6000);

const spec = (over: Partial<TraceSpec> = {}): TraceSpec => ({
  label: "guard",
  gameID: "nn-guard-a",
  difficulty: Difficulty.Hard,
  nations: 40,
  ticks: TICKS,
  ...over,
});

type Factory = (nation: Nation, game: Game) => AttackPolicy;

/** Asks every query before delegating, over every player in the game. */
export function probed(base: Factory): Factory {
  return (nation, game) => {
    const inner = base(nation, game);
    const id = nation.playerInfo.id;
    return {
      beginTurn: () => inner.beginTurn?.(),
      endTurn: () => inner.endTurn?.(),
      attackSent: (t, n, k) => inner.attackSent?.(t, n, k),
      engage: (ctx) => inner.engage(ctx),
      strengthStrategies: (ctx) => {
        const list = inner.strengthStrategies(ctx);
        return [
          () => {
            ctx.groups();
            for (const p of game.players()) {
              if (p.id() !== id && p.isAlive()) ctx.canReach(p);
            }
            return list.some((s) => s());
          },
        ];
      },
    };
  };
}

const rules: Factory = () => new RuleAttackPolicy();
const recorder: Factory = (nation, game) =>
  new DecisionRecorder(
    game,
    nation.playerInfo.id,
    0,
    "nn-guard-a",
    os.devNull,
    "full",
  );

const chain = async (s: TraceSpec, f?: Factory) =>
  (await traceWorld(s, undefined, undefined, f)).result.chain;

describe("policy queries must not change the game", () => {
  test.each([
    ["the rules", rules],
    ["the recorder", recorder],
  ])(
    "probing every player leaves %s unchanged",
    async (_n, base) => {
      const plain = await chain(spec(), base);
      const probe = await chain(spec(), probed(base));
      expect(probe).toBe(plain);
    },
    600_000,
  );

  test("negative control: a canReach that caches routes is caught", async () => {
    const proto = AiAttackBehavior.prototype as unknown as Record<
      string,
      unknown
    >;
    const quiet = proto.canReachQuietly;
    const plain = await chain(spec(), rules);
    // the old behaviour: policy queries write the planned-route cache
    proto.canReachQuietly = proto.canReach;
    try {
      const cached = await chain(spec(), probed(rules));
      expect(cached).not.toBe(plain);
    } finally {
      proto.canReachQuietly = quiet;
    }
  }, 600_000);
});

describe("canReachQuietly agrees with canReach", () => {
  test("same answer on 1000+ sampled candidates (land, boat, none)", async () => {
    const proto = AiAttackBehavior.prototype as unknown as Record<
      string,
      (this: unknown, ...a: unknown[]) => unknown
    >;
    const quiet = proto.canReachQuietly;
    const counts = { land: 0, boat: 0, none: 0, mismatch: 0, yes: 0, no: 0 };
    proto.canReachQuietly = function (this: unknown, target: unknown) {
      const q = quiet.call(this, target) as boolean;
      const c = proto.canReach.call(this, target) as boolean;
      if (q !== c) counts.mismatch++;
      if (q) counts.yes++;
      else counts.no++;
      if (proto.bordersByLand.call(this, target)) counts.land++;
      else if (proto.boatRoute.call(this, target) !== null) counts.boat++;
      else counts.none++;
      return q;
    };
    try {
      for (const map of ["world", "real:caribbean", "real:asia"]) {
        // ask about every player, as a network scoring all candidates would
        await traceWorld(
          spec({ map, nations: 30, ticks: 2500, gameID: "nn-guard-b" }),
          undefined,
          undefined,
          probed(rules),
        );
      }
    } finally {
      proto.canReachQuietly = quiet;
    }
    process.stderr.write(`[canReach] ${JSON.stringify(counts)}\n`);
    expect(counts.land + counts.boat + counts.none).toBeGreaterThanOrEqual(
      1000,
    );
    expect(counts.land).toBeGreaterThan(0);
    expect(counts.boat).toBeGreaterThan(0);
    expect(counts.none).toBeGreaterThan(0);
    expect(counts.yes).toBeGreaterThan(0);
    expect(counts.no).toBeGreaterThan(0);
    expect(counts.mismatch).toBe(0);
  }, 900_000);
});
