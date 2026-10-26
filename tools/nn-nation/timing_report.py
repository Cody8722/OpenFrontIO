"""Phase A of the nation timing: is the metronome gone, and is the strength the
same? Every number comes from the logs of tests/NationTimingEval.test.ts.

    python tools/nn-nation/timing_report.py
Reads .nn-nation-data/timing/<config>/<gameID>.json; writes
tools/nn-nation/baseline/timing_phaseA.{json,md,png}.

Verdicts for an equivalence margin (95% confidence interval of the paired
mean difference): "pass" when the whole interval is inside the margin, "FAIL"
when it lies wholly beyond it on one side, "inconclusive" otherwise (too wide:
more seeds, or say the evidence is not enough).
"""
import json
import os
import sys
from collections import Counter, defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy import stats  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
from eval_report import nation_ids, net_set  # noqa: E402

ROOT = os.environ.get("NN_DATA", ".nn-nation-data")
TIMING = os.path.join(ROOT, "timing")
BASE = os.path.join("tools", "nn-nation", "baseline")
SPREAD_CONFIGS = ["s025", "s050", "s075"]
MARGINS = dict(
    frequency=0.005, attacks=0.03, alive_pp=3.0, tiles=0.05, troops=0.05, actions=0.10
)


def load(config: str) -> dict:
    out = {}
    d = os.path.join(TIMING, config)
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if f.endswith(".json"):
                with open(os.path.join(d, f), encoding="utf8") as fh:
                    g = json.load(fh)
                out[g["gameID"]] = g
    return out


def ci(x) -> tuple[float, float, float]:
    x = np.asarray(x, float)
    m = x.mean()
    half = (
        stats.t.ppf(0.975, len(x) - 1) * x.std(ddof=1) / np.sqrt(len(x))
        if len(x) > 1
        else np.inf
    )
    return m, m - half, m + half


def verdict(lo: float, hi: float, margin: float) -> str:
    if lo >= -margin and hi <= margin:
        return "pass"
    if lo > margin or hi < -margin:
        return "FAIL"
    return "inconclusive"


# ------------------------------------------------------------ think logs ----


def think_ticks(game: dict) -> dict[int, list[int]]:
    by = defaultdict(list)
    for t in game["turns"]:
        by[t["n"]].append(t["k"])
    return {n: sorted(ks) for n, ks in by.items()}


def regularity(game: dict) -> dict:
    """The regularity measures of one game, all recomputable from the log."""
    lattice = game["lattice"]
    per = defaultdict(list)
    counts = []
    hist: Counter = Counter()
    tick_counts: Counter = Counter()
    lo = hi = None
    for n, ks in think_ticks(game).items():
        rate, first = lattice[n]["attackRate"], lattice[n]["attackTick"]
        counts.append(len(ks))
        for k in ks:
            tick_counts[k] += 1
        lo = ks[0] if lo is None else min(lo, ks[0])
        hi = ks[-1] if hi is None else max(hi, ks[-1])
        if len(ks) < 6:
            continue
        d = np.diff(ks)
        theta = 2 * np.pi * ((np.array(ks) - first) % rate) / rate
        per["phase"].append(abs(np.exp(1j * theta).mean()))
        per["multiple"].append(np.mean(d % rate == 0))
        per["cv"].append(d.std() / d.mean())
        if len(d) > 10 and d.std() > 0:
            per["lag1"].append(np.corrcoef(d[:-1], d[1:])[0, 1])
        per["mean_gap"].append(d.mean() / rate)
        for x in d / rate:
            hist[min(int(x * 10), 30)] += 1
    per_tick = np.array([tick_counts.get(k, 0) for k in range(lo, hi + 1)])
    return {
        **{k: float(np.mean(v)) if v else float("nan") for k, v in per.items()},
        "fano": float(per_tick.var() / per_tick.mean()),
        "max_simultaneous": int(per_tick.max()),
        "thinks_per_nation": float(np.mean(counts)),
        "hist": dict(hist),
    }


def summarize(games: dict) -> dict:
    rows = [regularity(g) for g in games.values()]
    out = {
        k: float(np.nanmean([r[k] for r in rows]))
        for k in ("phase", "multiple", "cv", "lag1", "mean_gap", "fano", "thinks_per_nation")
    }
    out["max_simultaneous"] = int(max(r["max_simultaneous"] for r in rows))
    hist: Counter = Counter()
    for r in rows:
        hist.update({int(k): v for k, v in r["hist"].items()})
    out["hist"] = {int(k): int(v) for k, v in sorted(hist.items())}
    return out


# --------------------------------------------------------------- strength ----


def game_metrics(g: dict) -> dict:
    ids = nation_ids(g)
    alive = [n for n in g["nations"] if n["alive"]]
    thinks = Counter(t["n"] for t in g["turns"])
    return dict(
        attacks=g["attacksStarted"],
        alive_pp=100.0 * len(alive) / len(ids),
        tiles=float(np.mean([n["tiles"] for n in alive] or [0])),
        troops=float(np.mean([n["troops"] for n in alive] or [0])),
        thinks=float(np.mean([thinks.get(n, 0) for n in range(len(g["lattice"]))])),
    )


def paired_report(legacy: dict, other: dict, name: str, out: dict) -> None:
    ids = sorted(set(legacy) & set(other))
    A = [game_metrics(legacy[i]) for i in ids]
    B = [game_metrics(other[i]) for i in ids]
    print(f"  {name}: {len(ids)} paired seeds")
    res = {}
    for key, label, margin, kind in (
        ("thinks", "thinks per nation (frequency)", MARGINS["frequency"], "rel"),
        ("attacks", "attacks started", MARGINS["attacks"], "rel"),
        ("alive_pp", "nations alive at 6000 (pp)", MARGINS["alive_pp"], "diff"),
        ("tiles", "mean tiles of survivors", MARGINS["tiles"], "rel"),
        ("troops", "mean troops of survivors", MARGINS["troops"], "rel"),
    ):
        a = np.array([x[key] for x in A])
        b = np.array([x[key] for x in B])
        d = (b - a) / a if kind == "rel" else b - a
        m, lo, hi = ci(d)
        v = verdict(lo, hi, margin)
        unit = "%" if kind == "rel" else " pp"
        s = 100 if kind == "rel" else 1
        print(
            f"    {label:<34} diff {m * s:+7.2f}{unit} [{lo * s:+.2f},{hi * s:+.2f}] "
            f"margin ±{margin * s:g}{unit}  {v}"
        )
        res[key] = dict(diff=float(m), lo=float(lo), hi=float(hi), margin=margin, verdict=v)
    out[name] = res


def action_report(legacy: dict, other: dict, name: str, out: dict) -> None:
    ids = sorted(set(legacy) & set(other))

    def totals(g):
        c: Counter = Counter()
        for byType in g["actions"].values():
            c.update(byType)
        c["ALL"] = sum(v for k, v in c.items() if k != "ALL")
        return c

    A = [totals(legacy[i]) for i in ids]
    B = [totals(other[i]) for i in ids]
    types = sorted(set().union(*[set(c) for c in A + B]))
    print(f"  {name}: actions by type, per game, margin ±{MARGINS['actions'] * 100:g}%")
    res = {}
    tally: Counter = Counter()
    for t in types:
        a = np.array([c.get(t, 0) for c in A], float)
        b = np.array([c.get(t, 0) for c in B], float)
        if a.mean() < 0.5 and b.mean() < 0.5:
            continue
        m, lo, hi = ci(b - a)
        base = a.mean() if a.mean() > 0 else float("nan")
        if a.mean() < 3:
            v = "inconclusive (too few events)"
        else:
            v = verdict(lo / base, hi / base, MARGINS["actions"])
        tally[v.split(" ")[0]] += 1
        res[t] = dict(
            a=float(a.mean()), b=float(b.mean()), rel=float(m / base),
            lo=float(lo / base), hi=float(hi / base), verdict=v,
        )
        print(
            f"    {t:<34} {a.mean():>9.1f} -> {b.mean():>9.1f}  {m / base * 100:+7.1f}% "
            f"[{lo / base * 100:+.1f},{hi / base * 100:+.1f}]  {v}"
        )
    print(f"    summary: {dict(tally)}")
    out[name] = dict(types=res, summary=dict(tally))


def mixed_report(A: dict, B: dict, out: dict) -> None:
    ids = sorted(set(A) & set(B))
    if not ids:
        return
    print(
        f"\n== 4. same game: half the nations think with spread 0.5, half on the "
        f"lattice ({len(ids)} seeds, both ways round) =="
    )
    per = defaultdict(list)
    for gid in ids:
        everyone = nation_ids(A[gid])
        sets = {"A": net_set(everyone, gid, False), "B": net_set(everyone, gid, True)}
        runs = {"A": A[gid], "B": B[gid]}
        for r, run in runs.items():
            for n in run["nations"]:
                assert n["timed"] == (n["id"] in sets[r]), (gid, r, n["id"])
        outcome = {}
        for r, run in runs.items():
            alive = {n["id"]: n for n in run["nations"]}
            outcome[r] = {
                i: dict(
                    alive=float(i in alive),
                    tiles=alive[i]["tiles"] if i in alive else 0,
                    troops=alive[i]["troops"] if i in alive else 0,
                )
                for i in everyone
            }
        d = defaultdict(list)
        lattice_value = defaultdict(list)
        for i in everyone:
            t, l = ("A", "B") if i in sets["A"] else ("B", "A")
            for m in ("alive", "tiles", "troops"):
                d[m].append(outcome[t][i][m] - outcome[l][i][m])
                lattice_value[m].append(outcome[l][i][m])
        per["alive_pp"].append(100 * np.mean(d["alive"]))
        for m in ("tiles", "troops"):
            per[m].append(np.mean(d[m]) / max(1e-9, np.mean(lattice_value[m])))
    res = {}
    for key, label, margin, s, unit in (
        ("alive_pp", "survival (pp)", MARGINS["alive_pp"], 1, " pp"),
        ("tiles", "tiles (vs the lattice nations)", MARGINS["tiles"], 100, "%"),
        ("troops", "troops (vs the lattice nations)", MARGINS["troops"], 100, "%"),
    ):
        m, lo, hi = ci(per[key])
        v = verdict(lo, hi, margin)
        print(
            f"    {label:<34} timed minus lattice {m * s:+7.2f}{unit} "
            f"[{lo * s:+.2f},{hi * s:+.2f}] margin ±{margin * s:g}{unit}  {v}"
        )
        res[key] = dict(diff=float(m), lo=float(lo), hi=float(hi), margin=margin, verdict=v)
    out["mixed_s050"] = res


# ------------------------------------------------------------------- main ----


def main() -> None:
    legacy = load("legacy")
    configs = {c: load(c) for c in SPREAD_CONFIGS}
    print(f"legacy {len(legacy)} seeds; " + ", ".join(f"{c} {len(g)}" for c, g in configs.items()))
    report: dict = {}

    print("\n== 1. is the metronome gone? (think logs, mean over games) ==")
    reg = {"legacy": summarize(legacy)}
    for c, g in configs.items():
        if g:
            reg[c] = summarize(g)
    s000 = load("s000")
    if s000:
        reg["s000"] = summarize(s000)
    print(
        f"  {'config':<8}{'phase R':>9}{'multiples':>11}{'cv':>7}{'lag-1':>8}"
        f"{'gap/R':>8}{'var/mean':>10}{'max sim.':>10}{'thinks/nation':>15}"
    )
    for c, r in reg.items():
        print(
            f"  {c:<8}{r['phase']:>9.3f}{r['multiple']:>11.3f}{r['cv']:>7.3f}"
            f"{r['lag1']:>8.3f}{r['mean_gap']:>8.4f}{r['fano']:>10.2f}"
            f"{r['max_simultaneous']:>10}{r['thinks_per_nation']:>15.1f}"
        )
    report["regularity"] = reg

    print("\n== 2. is the strength the same? (paired by seed, against the old lattice) ==")
    for c, g in configs.items():
        if g:
            paired_report(legacy, g, c, report.setdefault("strength", {}))

    print("\n== 3. action frequency by type ==")
    for c, g in configs.items():
        if g:
            action_report(legacy, g, c, report.setdefault("actions", {}))
    if s000:
        sub = [i for i in s000 if i in legacy]
        same = all(
            s000[i]["chain"] == legacy[i]["chain"] and s000[i]["actions"] == legacy[i]["actions"]
            for i in sub
        )
        print(f"\n  spread 0 on {len(sub)} seeds: same hash chain and same actions as the lattice: {same}")
        report["spread0_equals_lattice"] = bool(same)

    mixed_report(load("mix050A"), load("mix050B"), report)
    write(report, reg, legacy, configs)


def write(report: dict, reg: dict, legacy: dict, configs: dict) -> None:
    os.makedirs(BASE, exist_ok=True)
    with open(os.path.join(BASE, "timing_phaseA.json"), "w", encoding="utf8") as f:
        json.dump(report, f, indent=1, default=float)

    colors = {"legacy": "#c0392b", "s025": "#e08e0b", "s050": "#2471a3", "s075": "#1e8449"}
    names = [c for c in ("legacy", *SPREAD_CONFIGS) if c in reg]
    fig, ax = plt.subplots(2, 3, figsize=(16, 9))

    def raster(a, games, title):
        g = next(iter(games.values()))
        for row, (_, ks) in enumerate(sorted(think_ticks(g).items())[:12]):
            ks = [k for k in ks if 1000 <= k <= 1700]
            a.scatter(ks, [row] * len(ks), s=14, c="#2c3e50")
        a.set_title(title)
        a.set_xlabel("tick")
        a.set_ylabel("nation")

    raster(ax[0][0], legacy, "(a) thinks, old lattice")
    if configs.get("s050"):
        raster(ax[0][1], configs["s050"], "(b) thinks, spread 0.5 (same seed)")
    for c in names:
        h = reg[c]["hist"]
        xs = np.arange(0, 31)
        tot = sum(h.values())
        ax[0][2].plot(xs / 10, [h.get(int(x), 0) / tot for x in xs], label=c, color=colors[c], drawstyle="steps-mid")
    ax[0][2].set_title("(c) gap between thinks / attackRate")
    ax[0][2].set_xlabel("gap / rate")
    ax[0][2].legend()
    w = 0.8 / len(names)
    for j, key in enumerate(("phase", "multiple")):
        for i, c in enumerate(names):
            ax[1][0].bar(j + (i - len(names) / 2 + 0.5) * w, reg[c][key], w, color=colors[c], label=c if j == 0 else None)
    ax[1][0].set_xticks([0, 1])
    ax[1][0].set_xticklabels(["phase concentration\n(1 = metronome)", "gaps that are whole\nmultiples of the rate"])
    ax[1][0].set_title("(d) regularity")
    ax[1][0].legend()
    for j, key in enumerate(("cv", "lag1")):
        for i, c in enumerate(names):
            ax[1][1].bar(j + (i - len(names) / 2 + 0.5) * w, reg[c][key], w, color=colors[c])
    ax[1][1].set_xticks([0, 1])
    ax[1][1].set_xticklabels(["gap variation (cv)", "lag-1 autocorrelation"])
    ax[1][1].set_title("(e) spread of the gaps")
    ax[1][2].bar(range(len(names)), [reg[c]["fano"] for c in names], color=[colors[c] for c in names])
    ax[1][2].axhline(1.0, color="k", lw=0.8)
    ax[1][2].set_xticks(range(len(names)))
    ax[1][2].set_xticklabels(names)
    ax[1][2].set_title("(f) nations thinking in one tick: variance / mean (1 = Poisson)")
    fig.tight_layout()
    fig.savefig(os.path.join(BASE, "timing_phaseA.png"), dpi=110)
    plt.close(fig)

    with open(os.path.join(BASE, "timing_phaseA.md"), "w", encoding="utf8") as f:
        f.write("# Nation timing, phase A (jittered thinks), Hard nations, 54 fresh seeds\n\n")
        f.write(
            "| config | phase concentration | gaps that are multiples of the rate | gap cv | lag-1 | mean gap / rate | var/mean per tick |\n"
            "|---|---|---|---|---|---|---|\n"
        )
        for c in names:
            r = reg[c]
            f.write(
                f"| {c} | {r['phase']:.3f} | {r['multiple']:.3f} | {r['cv']:.3f} | "
                f"{r['lag1']:.3f} | {r['mean_gap']:.4f} | {r['fano']:.2f} |\n"
            )
        f.write("\n![timing](timing_phaseA.png)\n")
    print(f"\nwrote {BASE}/timing_phaseA.(json|md|png)")


if __name__ == "__main__":
    main()
