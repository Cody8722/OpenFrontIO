"""Evidence report: rules vs network on more seeds, mixed games, and the
"bot feel" baseline table.

    python tools/nn-nation/eval_report.py
Reads .nn-nation-data/eval/<mode>/*.json (NN_EVAL=1, tests/NationEval.test.ts)
and the earlier .nn-nation-data/takeover/<mode>/*.json (18 validation seeds).
Writes tools/nn-nation/baseline/{bot_baseline.json,bot_baseline.md,
bot_baseline.png,mixed.png}; later changes are compared with that table.
"""
import json
import os
from collections import Counter, defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy import stats  # noqa: E402

ROOT = os.environ.get("NN_DATA", ".nn-nation-data")
EVAL = os.path.join(ROOT, "eval")
VAL = os.path.join(ROOT, "takeover")
BASE = os.path.join("tools", "nn-nation", "baseline")


def load_dir(d: str) -> dict:
    out = {}
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if f.endswith(".json"):
                with open(os.path.join(d, f), encoding="utf8") as fh:
                    g = json.load(fh)
                out[g["gameID"]] = g
    return out


def paired(name: str, a, b) -> None:
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a
    n = len(d)
    se = d.std(ddof=1) / np.sqrt(n)
    t, p = stats.ttest_rel(b, a)
    try:
        pw = stats.wilcoxon(d).pvalue
    except ValueError:
        pw = float("nan")
    half = stats.t.ppf(0.975, n - 1) * se
    print(
        f"  {name:<36} A {a.mean():>12.3f}  B {b.mean():>12.3f}  diff {d.mean():>+10.3f} "
        f"[{d.mean() - half:+.3f},{d.mean() + half:+.3f}]  t-test p={p:.3f}  wilcoxon p={pw:.3f}"
    )


def gaps(game: dict, only_sends: bool) -> list[int]:
    last: dict[int, int] = {}
    out = []
    for t in sorted(game["turns"], key=lambda t: (t["n"], t["k"])):
        if only_sends and t["sent"] == 0:
            continue
        if t["n"] in last:
            out.append(t["k"] - last[t["n"]])
        last[t["n"]] = t["k"]
    return out


# ---------------------------------------------------------------- part 1 ----


def part1(rules: dict, net: dict, label: str) -> None:
    ids = sorted(set(rules) & set(net))
    print(f"\n== 1. rules (A) vs network (B), {label}: {len(ids)} paired seeds ==")
    R, N = [rules[i] for i in ids], [net[i] for i in ids]
    for name, f in (
        ("attacks started", lambda g: g["attacksStarted"]),
        ("attacks sent (all paths)", lambda g: len(g["sends"])),
        ("attacks by the strength block", lambda g: sum(s["strength"] for s in g["sends"])),
        ("strength decisions", lambda g: g["strength"]["decisions"]),
        ("strength attack rate", lambda g: g["strength"]["attacks"] / max(1, g["strength"]["decisions"])),
        ("per-game mean wave interval", lambda g: np.mean(gaps(g, True))),
        ("alive nations at 6000", lambda g: sum(n["alive"] for n in g["nations"])),
        ("mean tiles (alive)", lambda g: np.mean([n["tiles"] for n in g["nations"] if n["alive"]] or [0])),
        ("mean troops (alive)", lambda g: np.mean([n["troops"] for n in g["nations"] if n["alive"]] or [0])),
    ):
        paired(name, [f(g) for g in R], [f(g) for g in N])


def decomposition(games: dict, title: str) -> dict:
    tot: Counter = Counter()
    for g in games.values():
        for d in g.get("decisions", []):
            tot["decisions"] += 1
            if not d["c"]:
                tot["no candidate"] += 1
            elif d["atk"] and d["fail"] == 0:
                tot["attacked at the first try"] += 1
            elif d["atk"]:
                tot["attacked after a refusal"] += 1
            elif d["fail"] > 0:
                tot["every try refused"] += 1
            else:
                tot["chose / found nothing to attack"] += 1
            tot["refused attempts"] += d["fail"]
    n = tot["decisions"]
    print(f"  {title}: {n} decisions")
    for k in (
        "no candidate",
        "attacked at the first try",
        "attacked after a refusal",
        "every try refused",
        "chose / found nothing to attack",
        "refused attempts",
    ):
        share = f"{tot[k] / n:.3f}" if k != "refused attempts" else ""
        print(f"    {k:<34} {tot[k]:>7}  {share}")
    return dict(tot)


# ---------------------------------------------------------------- part 2 ----


def mix_hash(s: str) -> int:
    """tests/NationEval.test.ts mix(): FNV-1a plus a finalizer."""
    h = 2166136261
    for ch in s:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    h = ((h ^ (h >> 16)) * 2246822507) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 3266489909) & 0xFFFFFFFF
    return (h ^ (h >> 16)) & 0xFFFFFFFF


def nation_ids(game: dict) -> list[str]:
    """Every nation of the game, dead ones too (game.players() lists survivors only)."""
    import re

    req = int(re.search(r"-n(\d+)-s\d+$", game["gameID"]).group(1))
    name = game["map"].replace("real:", "")
    path = (
        os.path.join("resources", "maps", name, "manifest.json")
        if game["map"].startswith("real:")
        else os.path.join("tests", "testdata", "maps", name, "manifest.json")
    )
    with open(path, encoding="utf8") as f:
        placed = [n for n in json.load(f)["nations"] if n.get("coordinates") is not None]
    return [f"nation_{i}" for i in range(min(req, len(placed)))]


def net_set(ids: list[str], gid: str, swap: bool) -> set:
    ranked = sorted(ids, key=lambda i: (mix_hash(f"{i}|{gid}"), i))
    first = set(ranked[: (len(ids) + 1) // 2])
    return {i for i in ids if i not in first} if swap else first


def part2(mixA: dict, mixB: dict) -> dict | None:
    ids = sorted(set(mixA) & set(mixB))
    if not ids:
        return None
    print(f"\n== 2. mixed games: {len(ids)} seeds x 2 assignments ==")
    per_seed = defaultdict(list)
    group_runs = defaultdict(list)
    top_net = top_n = 0
    exp = []
    by_open: dict = defaultdict(lambda: defaultdict(list))
    for gid in ids:
        everyone = nation_ids(mixA[gid])
        sets = {"A": net_set(everyone, gid, False), "B": net_set(everyone, gid, True)}
        runs = {"A": mixA[gid], "B": mixB[gid]}
        out = {}  # run -> nation -> outcome; a dead nation is 0 tiles, 0 troops
        for r, run in runs.items():
            alive = {n["id"]: n for n in run["nations"]}
            # the Python assignment must reproduce what the engine recorded
            for n in run["nations"]:
                assert n["net"] == (n["id"] in sets[r]), (gid, r, n["id"])
            out[r] = {
                i: dict(alive=float(i in alive), tiles=alive[i]["tiles"] if i in alive else 0,
                        troops=alive[i]["troops"] if i in alive else 0)
                for i in everyone
            }
        diffs = defaultdict(list)
        for i in everyone:
            net_r, rules_r = ("A", "B") if i in sets["A"] else ("B", "A")
            for m in ("alive", "tiles", "troops"):
                diffs[m].append(float(out[net_r][i][m]) - float(out[rules_r][i][m]))
        for m, v in diffs.items():
            per_seed[m].append(np.mean(v))
            by_open[mixA[gid]["opening"]][m].append(np.mean(v))
        for r in ("A", "B"):
            for m in ("alive", "tiles", "troops"):
                group_runs[m].append(
                    (
                        np.mean([out[r][i][m] for i in everyone if i in sets[r]] or [0]),
                        np.mean([out[r][i][m] for i in everyone if i not in sets[r]] or [0]),
                    )
                )
            ns = runs[r]["nations"]
            best = max(ns, key=lambda x: x["tiles"])
            top_n += 1
            top_net += bool(best["net"])
            exp.append(len(sets[r]) / len(everyone))
    res: dict = {}
    print("  per nation, network minus rules (each nation plays both ways), mean over seeds")
    for m in ("alive", "tiles", "troops"):
        v = np.array(per_seed[m])
        t, p = stats.ttest_1samp(v, 0.0)
        half = stats.t.ppf(0.975, len(v) - 1) * v.std(ddof=1) / np.sqrt(len(v))
        print(f"    {m:<6} diff {v.mean():>+14.3f} [{v.mean() - half:+.3f},{v.mean() + half:+.3f}]  p={p:.3f}")
        res[m] = dict(diff=float(v.mean()), p=float(p))
    for o, d in by_open.items():
        print(f"    opening {o}: " + ", ".join(f"{m} {np.mean(d[m]):+.3f}" for m in ("alive", "tiles", "troops")))
    print("  group means inside the same game (A = rules group, B = network group)")
    for m in ("alive", "tiles", "troops"):
        paired(m, [x[1] for x in group_runs[m]], [x[0] for x in group_runs[m]])
    pexp = float(np.mean(exp))
    bt = stats.binomtest(int(top_net), top_n, pexp)
    print(
        f"  the largest nation by tiles played the network in {top_net} of {top_n} runs "
        f"(expected {pexp:.3f} if equal): p={bt.pvalue:.3f}"
    )
    res["top_share"] = dict(k=int(top_net), n=top_n, expected=pexp, p=float(bt.pvalue))
    res["_per_seed"] = {m: list(map(float, v)) for m, v in per_seed.items()}
    return res


# ---------------------------------------------------------------- part 3 ----


def regularity(games: dict, title: str) -> dict:
    on_phase = total = mult = n_int = 0
    rates = []
    multiples: Counter = Counter()
    counts_all = []
    stat = {k: [0, 0] for k in ("k1", "k2", "k1_adj", "k2_adj", "k1_cover", "k2_cover")}
    for g in games.values():
        by = defaultdict(list)
        sends = defaultdict(list)
        for t in g["turns"]:
            by[t["n"]].append(t["k"])
            if t["sent"] > 0:
                sends[t["n"]].append(t["k"])
        per_tick: Counter = Counter()
        lo, hi = None, None
        for n, ks in by.items():
            ks = sorted(ks)
            if len(ks) < 3:
                continue
            rate = Counter(np.diff(ks).tolist()).most_common(1)[0][0]
            off = Counter(k % rate for k in ks).most_common(1)[0]
            on_phase += off[1]
            total += len(ks)
            rates.append(rate)
            lo = ks[0] if lo is None else min(lo, ks[0])
            hi = ks[-1] if hi is None else max(hi, ks[-1])
            sk = sorted(sends[n])
            for a, b in zip(sk, sk[1:]):
                n_int += 1
                mult += (b - a) % rate == 0
                multiples[min(5, (b - a) // rate)] += 1
            for k in sk:
                per_tick[k] += 1
        if lo is not None:
            counts_all.append(np.array([per_tick.get(k, 0) for k in range(lo, hi + 1)]))

        for name, keyf in (
            ("k1", lambda d: (d["n"], tuple(d["c"]))),
            ("k2", lambda d: (d["n"], tuple(d["c"]), int(d["tr"] * 10))),
        ):
            groups = defaultdict(list)
            for d in g.get("decisions", []):
                if d["c"]:
                    groups[keyf(d)].append(d)
            for ds in groups.values():
                ds.sort(key=lambda d: d["k"])
                m = len(ds)
                stat[name + "_cover"][1] += m
                if m < 2:
                    continue
                stat[name + "_cover"][0] += m
                c = Counter(d["ch"] for d in ds)
                stat[name][0] += sum(v * (v - 1) // 2 for v in c.values())
                stat[name][1] += m * (m - 1) // 2
                for x, y in zip(ds, ds[1:]):
                    stat[name + "_adj"][1] += 1
                    stat[name + "_adj"][0] += x["ch"] == y["ch"]

    allc = np.concatenate(counts_all)
    res = {
        "turns_on_own_phase": on_phase / total,
        "intervals_multiple_of_rate": mult / max(1, n_int),
        "interval_multiples": {int(k): v / n_int for k, v in sorted(multiples.items())},
        "attack_rate_min_max_mean": [int(min(rates)), int(max(rates)), float(np.mean(rates))],
        "senders_per_tick_dist": {
            "no sender": float(np.mean(allc == 0)),
            "1": float(np.mean(allc == 1)),
            "2": float(np.mean(allc == 2)),
            "3+": float(np.mean(allc >= 3)),
        },
        "senders_per_tick_mean": float(allc.mean()),
        "senders_per_tick_fano": float(allc.var() / allc.mean()),
        "max_simultaneous_senders": int(allc.max()),
    }
    for name in ("k1", "k2"):
        for key in (name, name + "_adj"):
            s, p = stat[key]
            res["same_choice_" + key] = s / p if p else float("nan")
        c, t = stat[name + "_cover"]
        res["decisions_in_repeated_" + name] = c / t if t else float("nan")
    print(f"  {title}")
    print(f"    attack turns on the nation's own phase (tick % rate == attackTick): {res['turns_on_own_phase']:.4f}")
    print(f"    attack rate min/max/mean: {res['attack_rate_min_max_mean']}")
    print(f"    wave intervals that are multiples of the rate: {res['intervals_multiple_of_rate']:.4f}")
    print("    interval / rate (1..4, 5+): " + ", ".join(f"{k}:{v:.3f}" for k, v in res["interval_multiples"].items()))
    print(
        f"    senders per tick: {res['senders_per_tick_dist']}, mean {res['senders_per_tick_mean']:.3f}, "
        f"variance/mean {res['senders_per_tick_fano']:.2f}, max {res['max_simultaneous_senders']}"
    )
    for name in ("k1", "k2"):
        print(
            f"    same target in a similar situation ({name}): all pairs {res['same_choice_' + name]:.3f}, "
            f"consecutive {res['same_choice_' + name + '_adj']:.3f}, "
            f"decisions in a situation seen again {res['decisions_in_repeated_' + name]:.3f}"
        )
    return res


def first_game_raster(games: dict):
    g = next(iter(games.values()))
    allt, sends = defaultdict(set), defaultdict(set)
    for t in g["turns"]:
        allt[t["n"]].add(t["k"])
        if t["sent"]:
            sends[t["n"]].add(t["k"])
    return g["gameID"], allt, sends


# ----------------------------------------------------------------- main -----


def write_baseline(base: dict, rules: dict, mixed: dict | None) -> None:
    os.makedirs(BASE, exist_ok=True)
    with open(os.path.join(BASE, "bot_baseline.json"), "w", encoding="utf8") as f:
        json.dump(base, f, indent=1, default=float)

    colors = {"rules": "#c0392b", "net": "#2471a3"}
    w = 0.38
    fig, ax = plt.subplots(2, 2, figsize=(13, 9))
    gid, allt, sends = first_game_raster(rules)
    for row, n in enumerate(sorted(allt)[:12]):
        ks = sorted(k for k in allt[n] if 1000 <= k <= 1700)
        ax[0][0].scatter(ks, [row] * len(ks), s=8, c="#bbbbbb")
        ss = sorted(k for k in sends[n] if 1000 <= k <= 1700)
        ax[0][0].scatter(ss, [row] * len(ss), s=22, c=colors["rules"])
    ax[0][0].set_title(f"(a) attack turns sit on a fixed lattice ({gid}, rules)\ngrey = turn, red = turn with an attack")
    ax[0][0].set_xlabel("tick")
    ax[0][0].set_ylabel("nation")
    for j, m in enumerate(("rules", "net")):
        mult = base[m]["interval_multiples"]
        xs = sorted(mult)
        ax[0][1].bar(np.array(xs) + (j - 0.5) * w, [mult[x] for x in xs], w, label=m, color=colors[m])
    ax[0][1].set_title("(b) wave interval / the nation's attackRate\n(every interval is a whole multiple)")
    ax[0][1].set_xlabel("interval in attack periods (5 = 5 or more)")
    ax[0][1].set_ylabel("share of intervals")
    ax[0][1].legend()
    labels = [
        "same candidates\n(all pairs)",
        "same candidates\n(consecutive)",
        "+ same troop decile\n(all pairs)",
        "+ same troop decile\n(consecutive)",
    ]
    keys = ["same_choice_k1", "same_choice_k1_adj", "same_choice_k2", "same_choice_k2_adj"]
    for j, m in enumerate(("rules", "net")):
        ax[1][0].bar(np.arange(4) + (j - 0.5) * w, [base[m][k] for k in keys], w, label=m, color=colors[m])
    ax[1][0].set_xticks(range(4))
    ax[1][0].set_xticklabels(labels, fontsize=8)
    ax[1][0].set_ylim(0, 1)
    ax[1][0].set_title("(c) same nation, similar situation: share choosing the same target")
    ax[1][0].legend()
    names = ["no sender", "1", "2", "3+"]
    for j, m in enumerate(("rules", "net")):
        d = base[m]["senders_per_tick_dist"]
        ax[1][1].bar(np.arange(4) + (j - 0.5) * w, [d[k] for k in names], w, label=m, color=colors[m])
    ax[1][1].set_xticks(range(4))
    ax[1][1].set_xticklabels(["none", "1", "2", "3 or more"])
    ax[1][1].set_title("(d) nations attacking in the same tick")
    ax[1][1].set_xlabel("nations sending an attack in one tick")
    ax[1][1].legend()
    fig.tight_layout()
    fig.savefig(os.path.join(BASE, "bot_baseline.png"), dpi=110)
    plt.close(fig)

    if mixed:
        fig, ax = plt.subplots(1, 3, figsize=(13, 4))
        for a, m in zip(ax, ("alive", "tiles", "troops")):
            v = mixed["_per_seed"][m]
            a.hist(v, bins=15, color="#2471a3")
            a.axvline(0, color="k")
            a.axvline(float(np.mean(v)), color="#c0392b")
            a.set_title(f"network minus rules per seed: {m}")
        fig.tight_layout()
        fig.savefig(os.path.join(BASE, "mixed.png"), dpi=110)
        plt.close(fig)

    r, n = base["rules"], base["net"]

    def pair(key: str, fmt: str = "{:.3f}") -> tuple[str, str]:
        return fmt.format(r[key]), fmt.format(n[key])

    dist = lambda x: " / ".join(f"{x['senders_per_tick_dist'][k]:.3f}" for k in names)  # noqa: E731
    rows = [
        ("attack turns on the nation's own phase", *pair("turns_on_own_phase", "{:.4f}")),
        ("wave intervals that are whole multiples of attackRate", *pair("intervals_multiple_of_rate", "{:.4f}")),
        ("intervals of exactly 1 period", f"{r['interval_multiples'].get(1, 0):.3f}", f"{n['interval_multiples'].get(1, 0):.3f}"),
        ("attackRate min / max / mean", str(r["attack_rate_min_max_mean"]), str(n["attack_rate_min_max_mean"])),
        ("same target, same candidate set (all pairs)", *pair("same_choice_k1")),
        ("same target, same candidates (consecutive)", *pair("same_choice_k1_adj")),
        ("same target, + same troop decile (all pairs)", *pair("same_choice_k2")),
        ("same target, + same troop decile (consecutive)", *pair("same_choice_k2_adj")),
        ("ticks with 0 / 1 / 2 / 3+ nations attacking", dist(r), dist(n)),
        ("senders per tick: variance / mean (1 = Poisson)", *pair("senders_per_tick_fano", "{:.2f}")),
        ("most nations attacking in one tick", str(r["max_simultaneous_senders"]), str(n["max_simultaneous_senders"])),
    ]
    with open(os.path.join(BASE, "bot_baseline.md"), "w", encoding="utf8") as f:
        f.write("# Bot-feel baseline (Hard nations, 54 fresh seeds, 6000 ticks)\n\n")
        f.write("Compare any later change with this table (bot_baseline.json holds the numbers).\n\n")
        f.write("| measure | rules | network |\n|---|---|---|\n")
        for a, b, c in rows:
            f.write(f"| {a} | {b} | {c} |\n")
        f.write("\n![bot feel](bot_baseline.png)\n")
    print(f"\nwrote {BASE}/bot_baseline.(json|md|png)" + (" and mixed.png" if mixed else ""))


def main() -> None:
    rules = load_dir(os.path.join(EVAL, "rules"))
    net = load_dir(os.path.join(EVAL, "net"))
    val_rules = load_dir(os.path.join(VAL, "rules"))
    val_net = load_dir(os.path.join(VAL, "net"))
    print(f"fresh seeds: rules {len(rules)}, network {len(net)}; validation seeds: {len(val_rules)}")
    dr = dn = None
    if rules and net:
        part1(rules, net, "fresh seeds")
        part1({**val_rules, **rules}, {**val_net, **net}, "fresh + validation seeds pooled")
        print("\n  where the strength-block decisions end (fresh seeds)")
        dr = decomposition(rules, "rules")
        dn = decomposition(net, "network")
    mixed = part2(load_dir(os.path.join(EVAL, "mixA")), load_dir(os.path.join(EVAL, "mixB")))

    if rules and net:
        print("\n== 3. regularity of the existing behaviour (the 'bot feel' baseline) ==")
        base = {
            "rules": regularity(rules, "rules"),
            "net": regularity(net, "network"),
            "decisions": {"rules": dr, "net": dn},
        }
        write_baseline(base, rules, mixed)


if __name__ == "__main__":
    main()
