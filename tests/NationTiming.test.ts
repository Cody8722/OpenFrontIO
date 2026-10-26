// Behaviour pinned: the nation timing schedule (phase A: jittered gaps).
// - spread 0 thinks exactly on the old lattice (tick % rate == attackTick)
// - any spread keeps the mean gap at the nation's attackRate (half a percent)
//   and the gaps inside [(1 - s) R, (1 + s) R], uncorrelated from one to the next
// - the same seed gives the same schedule, and it never touches another stream
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { NationTiming } from "@openfront/engine/execution/nation/NationTiming";

function thinks(
  spread: number,
  rate: number,
  attackTick: number,
  ticks: number,
) {
  const timing = NationTiming.create({ spread }, 12345);
  const out: number[] = [];
  for (let t = 0; t < ticks; t++) {
    if (timing.shouldThink(t, rate, attackTick)) out.push(t);
  }
  return out;
}

const gaps = (ks: number[]) => ks.slice(1).map((k, i) => k - ks[i]);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("nation timing", () => {
  test("a spread of 0 is the old lattice", () => {
    const ks = thinks(0, 52, 17, 6000);
    expect(ks[0]).toBe(17);
    expect(ks.every((k) => k % 52 === 17)).toBe(true);
    expect(ks.length).toBe(Math.floor((6000 - 17 - 1) / 52) + 1);
  });

  test("the first think is on the lattice whatever the spread", () => {
    // the first tick asked about is 100; the lattice's next attack tick is 103
    const timing = NationTiming.create({ spread: 0.5 }, 1);
    let first = -1;
    for (let t = 100; t < 400 && first < 0; t++) {
      if (timing.shouldThink(t, 52, 51)) first = t;
    }
    expect(first).toBe(103);
  });

  test.each([0.25, 0.5, 0.75])(
    "spread %s: mean gap is the rate, gaps stay in range and are uncorrelated",
    (spread) => {
      const rate = 52;
      const g = gaps(thinks(spread, rate, 5, 2_000_000));
      expect(Math.abs(mean(g) / rate - 1)).toBeLessThan(0.005);
      expect(Math.min(...g)).toBeGreaterThanOrEqual(
        Math.floor((1 - spread) * rate),
      );
      expect(Math.max(...g)).toBeLessThanOrEqual(
        Math.ceil((1 + spread) * rate),
      );
      // lag-1 autocorrelation of the gaps
      const m = mean(g);
      let num = 0;
      let den = 0;
      for (let i = 0; i < g.length; i++) {
        den += (g[i] - m) ** 2;
        if (i > 0) num += (g[i] - m) * (g[i - 1] - m);
      }
      expect(Math.abs(num / den)).toBeLessThan(0.02);
      // the jitter is real: gaps are not all the rate, and few are exact multiples
      expect(new Set(g).size).toBeGreaterThan(10);
    },
  );

  test("the same seed gives the same schedule; the shared stream is untouched", () => {
    expect(thinks(0.5, 50, 3, 3000)).toEqual(thinks(0.5, 50, 3, 3000));
    const other = new PseudoRandom(777);
    const before = other.getState();
    thinks(0.5, 50, 3, 3000);
    expect(other.getState()).toEqual(before);
  });

  test("slots nobody asked about are dropped, as the lattice drops them", () => {
    const timing = NationTiming.create({ spread: 0 }, 1);
    expect(timing.shouldThink(10, 50, 10)).toBe(true);
    // ticks 11..59 never asked; the lattice's next attack tick (60) is still 60
    expect(timing.shouldThink(61, 50, 10)).toBe(false);
    expect(timing.shouldThink(110, 50, 10)).toBe(true);
  });

  test("a spread outside [0, 1) is refused", () => {
    expect(() => NationTiming.create({ spread: 1 }, 1)).toThrow();
    expect(() => NationTiming.create({ spread: -0.1 }, 1)).toThrow();
    expect(() => NationTiming.create({ spread: NaN }, 1)).toThrow();
  });
});
