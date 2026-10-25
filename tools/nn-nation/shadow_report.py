"""Agreement of the in-engine shadow network with the rules, next to the
offline numbers on the same rows.

    python tools/nn-nation/shadow_report.py [set]     (default: val)
Needs the shadow files from NN_SHADOW_COLLECT=1 (tests/NationShadow.test.ts).
Each shadow decision is joined to its recorded row by (game, nation, tick);
the offline prediction is the Python network on the recorded features.
"""
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
import nn_data as D  # noqa: E402
import nn_model as M  # noqa: E402

RULES = ["none", "hated", "veryWeak", "juicy", "victim", "crown", "weakest", "island"]


def main() -> None:
    which = sys.argv[1] if len(sys.argv) > 1 else "val"
    games, split = D._games()
    with open(os.path.join(D.ROOT, "schema.json"), encoding="utf8") as f:
        schema = json.load(f)
    ns, nc = len(schema["self"]), len(schema["cand"])
    maps = sorted({g["map"] for g in games})
    openings = ["normal", "rich"]
    z = np.load(os.path.join(D.ROOT, "train", "norm.npz"))
    norm = {k: (z[f"{k}_mean"], z[f"{k}_inv_std"]) for k in ("engage", "self", "cand")}
    ck = torch.load(os.path.join(D.ROOT, "train", "target.pt"))
    model = M.TargetNet(ns, nc, ck["h1"], ck["h2"], ck["h3"])
    model.load_state_dict(ck["state"])

    net, py, label, rule, mp, op = [], [], [], [], [], []
    problems = 0
    for g in games:
        if split[g["gameID"]] != which:
            continue
        with open(os.path.join(D.ROOT, "shadow", g["gameID"] + ".jsonl"), encoding="utf8") as f:
            shadow = [json.loads(line) for line in f if line.strip()]
        s_rows, c_rows, n_rows, y_rows = [], [], [], []
        keys = []
        with open(os.path.join(D.ROOT, "raw", g["gameID"] + ".jsonl"), encoding="utf8") as f:
            for line in f:
                r = json.loads(line)
                if r["t"] != "t" or len(r["c"]) == 0:
                    continue
                pad = np.zeros((D.MAX_CAND, nc), np.float32)
                pad[: len(r["c"])] = np.asarray(r["c"], np.float32)
                c_rows.append(pad)
                s_rows.append(r["s"])
                n_rows.append(len(r["c"]))
                y_rows.append(0 if r["rule"] is None else r["y"] + 1)
                keys.append((r["n"], r["k"]))
        t = dict(
            s=np.asarray(s_rows, np.float32),
            c=np.stack(c_rows),
            n=np.asarray(n_rows),
            y=np.asarray(y_rows),
        )
        pred, _ = M.target_predict(model, M.target_tensors(t, norm))
        by_key = {k: i for i, k in enumerate(keys)}
        used = 0
        for r in shadow:
            if r["candidates"] == 0:
                continue
            i = by_key.get((r["n"], r["tick"]))
            if i is None or y_rows[i] != r["picked"] or n_rows[i] != r["candidates"]:
                problems += 1
                continue
            used += 1
            net.append(r["net"])
            py.append(int(pred[i]))
            label.append(r["picked"])
            rule.append(r["rule"] or "none")
            mp.append(g["map"])
            op.append(g["opening"])
        if used != len(keys):
            problems += abs(len(keys) - used)
    net, py, label = np.asarray(net), np.asarray(py), np.asarray(label)
    rule, mp, op = np.asarray(rule), np.asarray(mp), np.asarray(op)
    print(f"{which}: {len(label)} decisions joined; join problems {problems}")
    print(f"network in the engine == network in Python on {np.mean(net == py):.5f} of rows")

    def row(title, mask):
        if mask.sum() == 0:
            return
        flag = "  [n<30: 不足以評估]" if mask.sum() < 30 else ""
        print(
            f"  {title:<20} engine {np.mean(net[mask] == label[mask]):.3f}"
            f"   offline {np.mean(py[mask] == label[mask]):.3f}   n={mask.sum()}{flag}"
        )

    print("\nagreement with the rules (engine shadow vs offline)")
    row("all", np.ones(len(label), bool))
    print("by opening")
    for o in openings:
        row(o, op == o)
    print("by map")
    for m in maps:
        row(m, mp == m)
    print("by strategy")
    for r in RULES:
        row(r, rule == r)


if __name__ == "__main__":
    main()
