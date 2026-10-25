"""Label counts per opening and per map, the train/val/test split by gameID,
and the number of usable rows.

    python tools/nn-nation/nation_data_split.py [dir]   (default .nn-nation-data)
Writes <dir>/split.json ({gameID: "train" | "val" | "test"}).

Engage labels (rows that reached the engage decision):
  below_reserve  troops under the reserve ratio: hold
  between        reserve reached, trigger not: a class of its own whatever the
                 rules' 1-in-10 draw gave; the draw stays in the rule shell
  both_passed    both ratios reached: attack
Target labels (rows that reached the strength block):
  <rule>                 the rule that attacked (with at least one candidate)
  none_with_candidates   candidates existed but every rule refused (donate next)
  none_zero_candidates   no candidate at all: not trained on
"""
import json
import os
import sys
from collections import Counter, defaultdict


def fnv(s: str) -> int:
    h = 2166136261
    for ch in s:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h


def main() -> None:
    root = sys.argv[1] if len(sys.argv) > 1 else ".nn-nation-data"
    with open(os.path.join(root, "games.jsonl"), encoding="utf8") as f:
        games = [json.loads(line) for line in f if line.strip()]

    # split: stratified by map x opening, at least one game each to val and test
    by_stratum = defaultdict(list)
    for g in games:
        by_stratum[(g["map"], g["opening"])].append(g["gameID"])
    split = {}
    for ids in by_stratum.values():
        ids.sort(key=lambda i: (fnv(i), i))
        n_val = max(1, round(len(ids) * 0.1))
        n_test = max(1, round(len(ids) * 0.1))
        for i, gid in enumerate(ids):
            split[gid] = "test" if i < n_test else "val" if i < n_test + n_val else "train"
    with open(os.path.join(root, "split.json"), "w", encoding="utf8") as f:
        json.dump(split, f, indent=1)

    meta = {g["gameID"]: g for g in games}
    tally = {k: defaultdict(Counter) for k in ("all", "opening", "map", "set")}

    def bump(gid: str, label: str) -> None:
        m = meta[gid]
        keys = {"all": "all", "opening": m["opening"], "map": m["map"], "set": split[gid]}
        for scope, key in keys.items():
            tally[scope][key][label] += 1

    for g in games:
        with open(os.path.join(root, "raw", g["gameID"] + ".jsonl"), encoding="utf8") as f:
            for line in f:
                r = json.loads(line)
                if r["t"] == "e":
                    if not r["reached"]:
                        bump(g["gameID"], "engage:not_reached")
                    elif not r["hasReserve"]:
                        bump(g["gameID"], "engage:below_reserve")
                    elif r["hasTrigger"]:
                        bump(g["gameID"], "engage:both_passed")
                    else:
                        bump(g["gameID"], "engage:between")
                else:
                    zero = len(r["c"]) == 0
                    if r["rule"] is not None:
                        bump(g["gameID"], "target:" + ("rule_zero_candidates!" if zero else r["rule"]))
                    else:
                        bump(g["gameID"], "target:" + ("none_zero_candidates" if zero else "none_with_candidates"))

    labels = sorted(tally["all"]["all"])
    print(f"games {len(games)}")
    for scope in ("all", "opening", "map", "set"):
        keys = sorted(tally[scope])
        print(f"\n== by {scope} ==")
        print("label".ljust(26) + "".join(k[-12:].rjust(13) for k in keys))
        for label in labels:
            print(label.ljust(26) + "".join(str(tally[scope][k][label]).rjust(13) for k in keys))

    print("\n== usable rows ==")
    for key in ("all", "train", "val", "test"):
        t = tally["all" if key == "all" else "set"][key]
        engage = t["engage:below_reserve"] + t["engage:between"] + t["engage:both_passed"]
        target = sum(v for l, v in t.items() if l.startswith("target:") and l != "target:none_zero_candidates")
        print(f"{key:<6} engage {engage}  target {target}")
    print("games per set:", dict(Counter(split.values())))
    missing = sum(1 for ids in by_stratum.values() if len({split[i] for i in ids}) < 3)
    print(f"strata {len(by_stratum)}, strata missing from a set: {missing}")


if __name__ == "__main__":
    main()
