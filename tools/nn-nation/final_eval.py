"""Opens the test split once, with the models train.py saved.

    python tools/nn-nation/final_eval.py

Refuses to run a second time (it leaves .nn-nation-data/train/test_opened).
"""
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
import nn_data as D  # noqa: E402
import nn_model as M  # noqa: E402

OUT = os.path.join(D.ROOT, "train")
MARK = os.path.join(OUT, "test_opened")


def main() -> None:
    if os.path.exists(MARK):
        sys.exit("test split was already opened once; refusing to open it again")
    data = D.load()
    schema, maps, openings = data["schema"], data["maps"], data["openings"]
    ns, nc = len(schema["self"]), len(schema["cand"])
    z = np.load(os.path.join(OUT, "norm.npz"))
    norm = {k: (z[f"{k}_mean"], z[f"{k}_inv_std"]) for k in ("engage", "self", "cand")}
    e, t = data["engage"], data["target"]
    e_te = D.subset(e, e["meta"][:, 0] == 2)
    t_te = D.subset(t, t["meta"][:, 0] == 2)

    ck = torch.load(os.path.join(OUT, "engage.pt"))
    em = M.EngageNet(ns, ck["h"])
    em.load_state_dict(ck["state"])
    pred, loss = M.engage_predict(em, M.engage_tensors(e_te, norm))
    e_rep = M.engage_report(e_te, pred, maps, openings)

    ck = torch.load(os.path.join(OUT, "target.pt"))
    tm = M.TargetNet(ns, nc, ck["h1"], ck["h2"], ck["h3"])
    tm.load_state_dict(ck["state"])
    pred, loss = M.target_predict(tm, M.target_tensors(t_te, norm))
    t_rep = M.target_report(t_te, pred, maps, openings, schema)

    text = "== ENGAGE (test) ==\n" + e_rep["text"] + "\n\n== TARGET (test) ==\n" + t_rep["text"] + "\n"
    with open(os.path.join(OUT, "test_report.txt"), "w", encoding="utf8") as f:
        f.write(text)
    with open(MARK, "w", encoding="utf8") as f:
        f.write("opened\n")
    print(text)


if __name__ == "__main__":
    main()
