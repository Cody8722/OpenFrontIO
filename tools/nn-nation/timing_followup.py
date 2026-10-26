"""Follow-up of the phase A report, on the same logs (nothing is re-run):
  1. troops, three ways (mean of log troops, median troops, paired per-nation log ratio)
  2. warships: dose response over s, and where the extra warships come from
  3. how many comparisons the whole phase A made, and what that does to "significant"

    python tools/nn-nation/timing_followup.py
Writes tools/nn-nation/baseline/timing_followup.md
"""
import os
import sys

import numpy as np
from scipy import stats

sys.path.insert(0, os.path.dirname(__file__))
from timing_report import BASE, SPREAD_CONFIGS, ci, load, verdict  # noqa: E402

TROOPS_MARGIN = 0.05  # +-5%, applied in log scale
OUT: list[str] = []


def say(s: str = "") -> None:
    print(s)
    OUT.append(s)


def pct(x: float) -> float:
    return (np.exp(x) - 1) * 100


def alive_troops(g: dict) -> dict[str, float]:
    return {n["id"]: float(n["troops"]) for n in g["nations"] if n["alive"] and n["troops"] > 0}


def troops_report(legacy: dict, other: dict, name: str) -> None:
    ids = sorted(set(legacy) & set(other))
    mean_log, med_diff, pair_log, pair_n = [], [], [], 0
    for i in ids:
        a, b = alive_troops(legacy[i]), alive_troops(other[i])
        if not a or not b:
            continue
        mean_log.append(np.mean(np.log(list(b.values()))) - np.mean(np.log(list(a.values()))))
        med_diff.append(np.log(np.median(list(b.values()))) - np.log(np.median(list(a.values()))))
        both = sorted(set(a) & set(b))
        if both:
            # one number per game: mean log ratio of the nations alive under both settings
            pair_log.append(np.mean([np.log(b[k] / a[k]) for k in both]))
            pair_n += len(both)
    say(f"  {name}: {len(mean_log)} games, {pair_n} nations alive under both settings")
    margin = np.log(1 + TROOPS_MARGIN)
    for label, x in (
        ("mean of log troops", mean_log),
        ("median troops (log ratio)", med_diff),
        ("paired same-nation ratio (log)", pair_log),
    ):
        m, lo, hi = ci(x)
        say(
            f"    {label:<32} {pct(m):+6.2f}% [{pct(lo):+.2f},{pct(hi):+.2f}]  "
            f"margin +-5%  {verdict(lo, hi, margin)}"
        )


def warships(g: dict) -> float:
    return float(sum(a.get("ConstructionExecution:Warship", 0) for a in g["actions"].values()))


def main() -> None:
    legacy = load("legacy")
    cfg = {c: load(c) for c in SPREAD_CONFIGS}

    say("# Phase A follow-up (same logs, nothing re-run)")
    say()
    say("## 1. Troops, three ways (against the old lattice, 54 paired seeds)")
    say()
    for c in SPREAD_CONFIGS:
        troops_report(legacy, cfg[c], c)
    say()

    say("## 2. Warships: dose response")
    say()
    ids = sorted(set(legacy) & set(cfg["s025"]) & set(cfg["s050"]) & set(cfg["s075"]))
    base = np.array([warships(legacy[i]) for i in ids])
    say(f"  legacy: {base.mean():.1f} warships per game ({len(ids)} games)")
    rels = {}
    for c in SPREAD_CONFIGS:
        w = np.array([warships(cfg[c][i]) for i in ids])
        m, lo, hi = ci((w - base) / base.mean())
        rels[c] = m
        say(f"  {c}: {w.mean():7.1f}  {m * 100:+6.1f}% [{lo * 100:+.1f},{hi * 100:+.1f}]  "
            f"margin +-10%  {verdict(lo, hi, 0.10)}")
    xs = np.array([0.25, 0.5, 0.75])
    slopes = [
        np.polyfit(xs, np.array([warships(cfg[c][i]) for c in SPREAD_CONFIGS]) / base.mean(), 1)[0]
        for i in ids
    ]
    m, lo, hi = ci(slopes)
    say(f"  per-game slope of warships/legacy-mean against s: {m:+.3f} per unit s [{lo:+.3f},{hi:+.3f}]")
    say(f"  the three means: {rels['s025'] * 100:+.1f}%, {rels['s050'] * 100:+.1f}%, {rels['s075'] * 100:+.1f}%")
    for c in ("mix050A", "mix050B"):
        mix = load(c)
        mids = sorted(set(legacy) & set(mix))
        w = np.array([warships(mix[i]) for i in mids])
        b = np.array([warships(legacy[i]) for i in mids])
        m, lo, hi = ci((w - b) / b.mean())
        say(f"  {c} (half the nations jittered): {w.mean():7.1f}  {m * 100:+6.1f}% [{lo * 100:+.1f},{hi * 100:+.1f}]")
    say()

    say("  s050 minus legacy, warships per game, by map:")
    by_map: dict[str, list[float]] = {}
    for i in ids:
        by_map.setdefault(legacy[i]["map"], []).append(warships(cfg["s050"][i]) - warships(legacy[i]))
    for k, v in sorted(by_map.items()):
        say(f"    {k:<16} {np.mean(v):+7.1f} per game  ({len(v)} games)")
    alive_a = np.array([sum(n["alive"] for n in legacy[i]["nations"]) for i in ids])
    alive_b = np.array([sum(n["alive"] for n in cfg["s050"][i]["nations"]) for i in ids])
    w_b = np.array([warships(cfg["s050"][i]) for i in ids])
    say(f"  nations alive at the end, legacy vs s050: {alive_a.mean():.1f} vs {alive_b.mean():.1f}")
    say(f"  warships per game against nations alive (s050): correlation {np.corrcoef(alive_b, w_b)[0, 1]:+.2f}")
    swing = sorted(ids, key=lambda i: abs(warships(cfg["s050"][i]) - warships(legacy[i])), reverse=True)[:5]
    say("  five games with the largest warship swing (legacy -> s050):")
    for i in swing:
        say(f"    {i:<28} {warships(legacy[i]):6.0f} -> {warships(cfg['s050'][i]):6.0f}")
    say()

    say("## 3. How many comparisons did phase A make")
    say()
    n_strength, n_actions, n_mixed = 5 * 3, 16 * 3, 3
    total = n_strength + n_actions + n_mixed
    say(f"  strength 5 metrics x 3 spreads = {n_strength}; action types 16 (incl. ALL) x 3 = {n_actions}; "
        f"mixed games {n_mixed}: {total} in the first report")
    say("  follow-up: troops 3 methods x 3 spreads = 9 (re-analysis of 3 of them), warships 3 + 2 mixed + 1 slope")
    say(f"  at 95%, about {0.05 * total:.1f} of {total} intervals exclude zero by chance alone; "
        "the first report had 2 (warships s050, emoji s050)")
    say(f"  Bonferroni threshold: p < {0.05 / total:.4f} per comparison")
    t = stats.ttest_rel(w_b, base)
    say(f"  warships s050 vs legacy paired t-test p = {t.pvalue:.3f}")

    with open(os.path.join(BASE, "timing_followup.md"), "w", encoding="utf8") as fh:
        fh.write("\n".join(OUT) + "\n")


if __name__ == "__main__":
    main()
