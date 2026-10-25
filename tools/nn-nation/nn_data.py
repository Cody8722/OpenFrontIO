"""Loads the collected nation decision data (.nn-nation-data) into arrays.

Engage rows (reached the engage decision), 3 classes:
  0 below_reserve, 1 between (reserve reached, trigger not: any draw result),
  2 both_passed
Target rows (reached the strength block, at least one candidate):
  label 0 = "no attack" (every rule refused), k + 1 = candidate k was attacked
Rows with zero candidates are left out.
"""
import json
import os

import numpy as np

ROOT = os.environ.get("NN_DATA", ".nn-nation-data")
MAX_CAND = 60
ENGAGE_CLASSES = ["below_reserve", "between", "both_passed"]
SETS = ["train", "val", "test"]


def _games():
    with open(os.path.join(ROOT, "games.jsonl"), encoding="utf8") as f:
        games = [json.loads(line) for line in f if line.strip()]
    with open(os.path.join(ROOT, "split.json"), encoding="utf8") as f:
        split = json.load(f)
    return games, split


def load():
    """Returns dict with 'schema', 'maps', 'openings', 'engage', 'target'."""
    with open(os.path.join(ROOT, "schema.json"), encoding="utf8") as f:
        schema = json.load(f)
    games, split = _games()
    maps = sorted({g["map"] for g in games})
    openings = ["normal", "rich"]
    nc = len(schema["cand"])

    e_x, e_y, e_meta = [], [], []
    t_s, t_c, t_n, t_y, t_rule, t_meta = [], [], [], [], [], []
    for g in games:
        meta = (
            SETS.index(split[g["gameID"]]),
            maps.index(g["map"]),
            openings.index(g["opening"]),
        )
        with open(os.path.join(ROOT, "raw", g["gameID"] + ".jsonl"), encoding="utf8") as f:
            for line in f:
                r = json.loads(line)
                if r["t"] == "e":
                    if not r["reached"]:
                        continue
                    if not r["hasReserve"]:
                        y = 0
                    elif r["hasTrigger"]:
                        y = 2
                    else:
                        y = 1
                    e_x.append(r["s"])
                    e_y.append(y)
                    e_meta.append(meta)
                else:
                    n = len(r["c"])
                    if n == 0:
                        continue
                    assert n <= MAX_CAND, n
                    pad = np.zeros((MAX_CAND, nc), np.float32)
                    pad[:n] = np.asarray(r["c"], np.float32)
                    t_c.append(pad)
                    t_s.append(r["s"])
                    t_n.append(n)
                    if r["rule"] is None:
                        t_y.append(0)
                        t_rule.append("none")
                    else:
                        assert r["y"] >= 0, (g["gameID"], r["k"])
                        t_y.append(r["y"] + 1)
                        t_rule.append(r["rule"])
                    t_meta.append(meta)

    engage = dict(
        x=np.asarray(e_x, np.float32),
        y=np.asarray(e_y, np.int64),
        meta=np.asarray(e_meta, np.int64),  # set, map, opening
    )
    target = dict(
        s=np.asarray(t_s, np.float32),
        c=np.stack(t_c),
        n=np.asarray(t_n, np.int64),
        y=np.asarray(t_y, np.int64),
        rule=np.asarray(t_rule),
        meta=np.asarray(t_meta, np.int64),
    )
    return dict(schema=schema, maps=maps, openings=openings, engage=engage, target=target)


def subset(d, mask):
    return {k: v[mask] for k, v in d.items()}


def fit_norm(data):
    """Mean and 1/std from the training rows only (std 0 -> 1)."""
    tr_e = data["engage"]["meta"][:, 0] == 0
    tr_t = data["target"]["meta"][:, 0] == 0
    t = data["target"]
    ex = data["engage"]["x"][tr_e]
    ts = t["s"][tr_t]
    real = np.arange(MAX_CAND)[None, :] < t["n"][tr_t][:, None]
    tc = t["c"][tr_t][real]

    def ms(a):
        m = a.mean(0)
        sd = a.std(0)
        sd[sd < 1e-8] = 1.0
        return m.astype(np.float32), (1.0 / sd).astype(np.float32)

    return {"engage": ms(ex), "self": ms(ts), "cand": ms(tc)}
