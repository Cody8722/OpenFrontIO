// Behaviour pinned: the target network's inference is a plain, deterministic
// feed-forward pass (ReLU, max over candidates, first-wins argmax) that does not
// depend on the order the candidates come in.
import {
  argmax,
  attackNetLogits,
  AttackNetWeights,
} from "@openfront/engine/execution/utils/AttackNet";
import { ATTACK_NET_WEIGHTS } from "@openfront/engine/execution/utils/AttackNetWeights";

// 1 self feature, 1 candidate feature, every layer one unit wide, all weights 1
const tiny: AttackNetWeights = {
  ns: 1,
  nc: 1,
  h1: 1,
  h2: 1,
  h3: 1,
  selfMean: [0],
  selfInvStd: [1],
  candMean: [0],
  candInvStd: [1],
  cs: [[1]],
  ss: [[1]],
  b1: [0],
  w2: [[1]],
  b2: [0],
  w3: [1],
  b3: 0,
  n1: [[1, 1]],
  nb1: [0],
  n2: [1],
  nb2: 0,
};

describe("attack network inference", () => {
  test("matches a hand-computed pass", () => {
    // self 2: layer 1 gives relu(c + 2) = 3, 5, 0; the no-attack head sees
    // (2, max 5) and gives 7
    expect(attackNetLogits(tiny, [2], [[1], [3], [-5]])).toEqual([7, 3, 5, 0]);
    // self -1: relu(c - 1) = 0, 2, 0; no-attack head sees (-1, 2) -> 1
    const logits = attackNetLogits(tiny, [-1], [[1], [3], [-5]]);
    expect(logits).toEqual([1, 0, 2, 0]);
    expect(argmax(logits)).toBe(2);
  });

  test("argmax takes the first of equal scores", () => {
    expect(argmax([3, 1, 3])).toBe(0);
    expect(argmax([1, 4, 4])).toBe(1);
  });

  test("candidate order only reorders the scores", () => {
    const self = ATTACK_NET_WEIGHTS.selfMean.map((m, i) => m + i * 0.01);
    const rows = [0, 1, 2].map((r) =>
      ATTACK_NET_WEIGHTS.candMean.map(
        (m, i) => m + 0.1 * ((i * 7 + r * 3) % 5),
      ),
    );
    const a = attackNetLogits(ATTACK_NET_WEIGHTS, self, rows);
    const b = attackNetLogits(ATTACK_NET_WEIGHTS, self, [
      rows[2],
      rows[0],
      rows[1],
    ]);
    expect(b[0]).toBe(a[0]);
    expect([b[1], b[2], b[3]]).toEqual([a[3], a[1], a[2]]);
  });

  test("the exported weights give finite scores and the same bits every call", () => {
    const self = ATTACK_NET_WEIGHTS.selfMean.slice();
    const rows = [ATTACK_NET_WEIGHTS.candMean.slice()];
    const a = attackNetLogits(ATTACK_NET_WEIGHTS, self, rows);
    const b = attackNetLogits(ATTACK_NET_WEIGHTS, self, rows);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(b).toEqual(a);
  });
});
