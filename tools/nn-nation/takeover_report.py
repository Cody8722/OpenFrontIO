"""Rules vs network takeover on the same seeds: behaviour distributions.

    python tools/nn-nation/takeover_report.py [set]      (default: val)
Needs the files from NN_TAKEOVER=1 (tests/NationTakeover.test.ts) and, for the
"would the rules have attacked" numbers, the shadow files (NationShadow.test.ts).
Games are paired by seed (gameID), so differences are paired differences.
"""
import json
import os
import sys

import numpy as np

ROOT = os.environ.get("NN_DATA", ".nn-nation-data")
T_CRIT = {5: 2.571, 10: 2.228, 17: 2.110, 20: 2.086, 30: 2.042}


def load(mode: str, ids: list[str]) -> list[dict]:
    out = []
    for gid in ids:
        with open(os.path.join(ROOT, "takeover", mode, gid + ".json"), encoding="utf8") as f:
            out.append(json.load(f))
    return out


def gaps(game: dict) -> list[int]:
    """Ticks between consecutive attack turns (any attack sent) of the same nation."""
    last: dict[int, int] = {}
    out = []
    for t in sorted(game["turns"], key=lambda t: (t["n"], t["k"])):
        if t["sent"] == 0:
            continue
        if t["n"] in last:
            out.append(t["k"] - last[t["n"]])
        last[t["n"]] = t["k"]
    return out


def paired(name: str, a: np.ndarray, b: np.ndarray) -> None:
    d = b - a
    se = d.std(ddof=1) / np.sqrt(len(d))
    t = d.mean() / se if se > 0 else 0.0
    crit = T_CRIT.get(len(d) - 1, 2.1)
    verdict = "differs" if abs(t) > crit else "same level"
    print(
        f"  {name:<34} rules {a.mean():>10.2f}  net {b.mean():>10.2f}  "
        f"diff {d.mean():>+9.2f} (t={t:+.2f}, {verdict})"
    )


def main() -> None:
    which = sys.argv[1] if len(sys.argv) > 1 else "val"
    with open(os.path.join(ROOT, "split.json"), encoding="utf8") as f:
        split = json.load(f)
    ids = sorted(g for g, s in split.items() if s == which)
    rules, net = load("rules", ids), load("net", ids)
    print(f"{len(ids)} seeds ({which}); paired by seed\n")

    print("network counters (summed over games)")
    keys = list(net[0]["stats"])
    tot = {k: sum(g["stats"][k] for g in net) for k in keys}
    for k in keys:
        print(f"  {k:<14} {tot[k]}")
    print(f"  crown fallback fired {tot['crownFired']} of {tot['crownTried']} tries")

    print("\nper-game totals")
    for label, f in (
        ("attacks started", lambda g: g["attacksStarted"]),
        ("attacks sent (all paths)", lambda g: len(g["sends"])),
        ("attacks sent by strength block", lambda g: sum(s["strength"] for s in g["sends"])),
        ("attack turns with a send", lambda g: sum(t["sent"] > 0 for t in g["turns"])),
        ("strength decisions", lambda g: g["strength"]["decisions"]),
        ("strength attack rate", lambda g: g["strength"]["attacks"] / max(1, g["strength"]["decisions"])),
        ("boat share of sends", lambda g: np.mean([s["kind"] == "boat" for s in g["sends"]])),
    ):
        paired(label, np.array([f(g) for g in rules], float), np.array([f(g) for g in net], float))

    print("\nattack-wave intervals (ticks between a nation's consecutive attack turns)")
    for name, games in (("rules", rules), ("net", net)):
        allg = np.array([x for g in games for x in gaps(g)], float)
        q = np.percentile(allg, [10, 50, 90])
        print(
            f"  {name:<6} n={len(allg)} mean {allg.mean():.1f} sd {allg.std():.1f} "
            f"cv {allg.std() / allg.mean():.2f} p10/p50/p90 {q[0]:.0f}/{q[1]:.0f}/{q[2]:.0f}"
        )
    paired(
        "per-game mean interval",
        np.array([np.mean(gaps(g)) for g in rules]),
        np.array([np.mean(gaps(g)) for g in net]),
    )
    paired(
        "per-game interval sd",
        np.array([np.std(gaps(g)) for g in rules]),
        np.array([np.std(gaps(g)) for g in net]),
    )

    print("\nwho the strength block attacked (share of its sends)")

    def share(games, pred):
        sel = [s for g in games for s in g["sends"] if s["strength"]]
        return (np.mean([pred(s) for s in sel]) if sel else float("nan")), len(sel)

    for label, pred in (
        ("shares a land border", lambda s: s["border"]),
        ("overseas (no border)", lambda s: s["target"] == "player" and not s["border"]),
        ("hostile relation", lambda s: s["hostile"]),
        ("runaway leader", lambda s: s["leader"]),
        ("by boat", lambda s: s["kind"] == "boat"),
        ("weaker than us (ratio < 0)", lambda s: s["target"] == "player" and s["logRatio"] < 0),
    ):
        r, rn = share(rules, pred)
        n, nn = share(net, pred)
        print(f"  {label:<28} rules {r:.3f} (n={rn})   net {n:.3f} (n={nn})")
    for name, games in (("rules", rules), ("net", net)):
        lr = [s["logRatio"] for g in games for s in g["sends"] if s["strength"] and s["target"] == "player"]
        print(f"  mean log10(their/our troops) {name}: {np.mean(lr):+.3f}")

    print("\nnations at tick 6000")

    def per(games, f):
        return np.array([f(g["nations"]) for g in games], float)

    for label, f in (
        ("alive nations", lambda ns: sum(n["alive"] for n in ns)),
        ("mean tiles (alive)", lambda ns: np.mean([n["tiles"] for n in ns if n["alive"]] or [0])),
        ("median tiles (alive)", lambda ns: np.median([n["tiles"] for n in ns if n["alive"]] or [0])),
        ("largest nation tiles", lambda ns: max(n["tiles"] for n in ns)),
        ("mean troops (alive)", lambda ns: np.mean([n["troops"] for n in ns if n["alive"]] or [0])),
        ("median troops (alive)", lambda ns: np.median([n["troops"] for n in ns if n["alive"]] or [0])),
    ):
        paired(label, per(rules, f), per(net, f))

    # "would the rules have attacked": measured with the shadow on rule-driven games
    shadow_dir = os.path.join(ROOT, "shadow")
    if os.path.isdir(shadow_dir):
        none_when_rules_attack = rules_none_net_attack = rule_att = rule_none = 0
        for gid in ids:
            with open(os.path.join(shadow_dir, gid + ".jsonl"), encoding="utf8") as f:
                for line in f:
                    r = json.loads(line)
                    if r["candidates"] == 0:
                        continue
                    if r["rule"] is not None:
                        rule_att += 1
                        none_when_rules_attack += r["net"] == 0
                    else:
                        rule_none += 1
                        rules_none_net_attack += r["net"] > 0
        print("\nnetwork vs rules on the same rule-driven decisions (shadow, candidates > 0)")
        print(f"  rules attacked ({rule_att}): network said 'no attack' {none_when_rules_attack / rule_att:.3f}")
        print(f"  rules did not  ({rule_none}): network would attack {rules_none_net_attack / rule_none:.3f}")


if __name__ == "__main__":
    main()
