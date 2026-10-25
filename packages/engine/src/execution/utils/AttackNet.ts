// Deterministic inference of the target-selection network: only additions,
// multiplications, comparisons (ReLU, max) and a fixed summation order, so every
// client computes the same bits. Draws no random numbers and touches no game
// state. Weights come from tools/nn-nation/export_weights.py.

export interface AttackNetWeights {
  ns: number; // self features
  nc: number; // candidate features
  h1: number;
  h2: number;
  h3: number;
  selfMean: number[];
  selfInvStd: number[];
  candMean: number[];
  candInvStd: number[];
  cs: number[][]; // [h1][nc]  candidate part of layer 1
  ss: number[][]; // [h1][ns]  self part of layer 1
  b1: number[];
  w2: number[][]; // [h2][h1]
  b2: number[];
  w3: number[]; // [h2]
  b3: number;
  n1: number[][]; // [h3][ns + h2]  the "no attack" head
  nb1: number[];
  n2: number[]; // [h3]
  nb2: number;
}

function dot(w: number[], x: ArrayLike<number>, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += w[i] * x[i];
  return s;
}

/**
 * Scores [no attack, candidate 0, candidate 1, ...] for one decision. The
 * candidate rows are in the order of AttackFeatures.CAND_FEATURES; the result
 * has one more entry than there are candidates. Needs at least one candidate.
 */
export function attackNetLogits(
  w: AttackNetWeights,
  selfRaw: number[],
  candRaw: number[][],
): number[] {
  const s = new Array<number>(w.ns);
  for (let i = 0; i < w.ns; i++) {
    s[i] = (selfRaw[i] - w.selfMean[i]) * w.selfInvStd[i];
  }

  // the self part of layer 1 is the same for every candidate
  const selfH1 = new Array<number>(w.h1);
  for (let j = 0; j < w.h1; j++) selfH1[j] = dot(w.ss[j], s, w.ns) + w.b1[j];

  const pooled = new Array<number>(w.h2).fill(0); // ReLU outputs are >= 0
  const scores = new Array<number>(candRaw.length);
  const c = new Array<number>(w.nc);
  const h1 = new Array<number>(w.h1);
  const h2 = new Array<number>(w.h2);
  for (let k = 0; k < candRaw.length; k++) {
    for (let i = 0; i < w.nc; i++) {
      c[i] = (candRaw[k][i] - w.candMean[i]) * w.candInvStd[i];
    }
    for (let j = 0; j < w.h1; j++) {
      const v = dot(w.cs[j], c, w.nc) + selfH1[j];
      h1[j] = v > 0 ? v : 0;
    }
    for (let j = 0; j < w.h2; j++) {
      const v = dot(w.w2[j], h1, w.h1) + w.b2[j];
      h2[j] = v > 0 ? v : 0;
      if (h2[j] > pooled[j]) pooled[j] = h2[j];
    }
    scores[k] = dot(w.w3, h2, w.h2) + w.b3;
  }

  // "no attack": a small head on the self features and the max over candidates
  const joined = s.concat(pooled);
  let none = w.nb2;
  for (let j = 0; j < w.h3; j++) {
    const v = dot(w.n1[j], joined, w.ns + w.h2) + w.nb1[j];
    if (v > 0) none += w.n2[j] * v;
  }
  return [none, ...scores];
}

/** Index of the largest logit, the first on ties: 0 = no attack, k + 1 = candidate k. */
export function argmax(logits: number[]): number {
  let best = 0;
  for (let i = 1; i < logits.length; i++) {
    if (logits[i] > logits[best]) best = i;
  }
  return best;
}
