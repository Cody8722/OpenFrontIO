"""Trains the engage and target networks on the train split, picks the
hyperparameters and early-stops on the validation split. The test split is
never touched here (see final_eval.py).

    python tools/nn-nation/train.py            # from the repo root
Outputs go to .nn-nation-data/train/.
"""
import itertools
import json
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
import nn_data as D  # noqa: E402
import nn_model as M  # noqa: E402

SEED = 20260101
OUT = os.path.join(D.ROOT, "train")


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    logf = open(os.path.join(OUT, "log.jsonl"), "w", encoding="utf8")

    def log(rec: dict) -> None:
        logf.write(json.dumps(rec) + "\n")
        logf.flush()

    t0 = time.time()
    data = D.load()
    print(f"loaded in {time.time() - t0:.0f}s", flush=True)
    schema, maps, openings = data["schema"], data["maps"], data["openings"]
    ns, nc = len(schema["self"]), len(schema["cand"])
    norm = D.fit_norm(data)
    e, t = data["engage"], data["target"]
    # only train (0) and val (1) rows are used here
    e_tr, e_va = (D.subset(e, e["meta"][:, 0] == k) for k in (0, 1))
    t_tr, t_va = (D.subset(t, t["meta"][:, 0] == k) for k in (0, 1))
    print(f"engage rows train {len(e_tr['y'])} val {len(e_va['y'])}; "
          f"target rows train {len(t_tr['y'])} val {len(t_va['y'])}", flush=True)

    base = dict(seed=SEED, batch=512, max_epochs=80, patience=8)

    # ---- engage ----
    et, ev = M.engage_tensors(e_tr, norm), M.engage_tensors(e_va, norm)
    results = []
    for h, lr in itertools.product([32, 64, 128], [1e-3, 3e-3]):
        cfg = dict(base, lr=lr, wd=0.0)
        tag = f"engage h={h} lr={lr}"
        model, best = M.train_engage(et, ev, ns, h, cfg, log, tag)
        print(f"{tag}: val loss {best['loss']:.4f} acc {best['acc']:.4f} epoch {best['epoch']}", flush=True)
        results.append((best["acc"], -best["loss"], h, lr, model, best))
    results.sort(key=lambda r: (r[0], r[1]), reverse=True)
    acc, _, h, lr, model, best = results[0]
    torch.save({"h": h, "state": model.state_dict()}, os.path.join(OUT, "engage.pt"))
    pred, _ = M.engage_predict(model, ev)
    e_rep = M.engage_report(e_va, pred, maps, openings)
    engage_cfg = dict(h=h, lr=lr, epoch=best["epoch"], val_acc=acc)

    # ---- target ----
    tt, tv = M.target_tensors(t_tr, norm), M.target_tensors(t_va, norm)
    results = []
    for (h1, h2), lr, wd in itertools.product([(64, 32), (128, 64)], [1e-3, 3e-3], [0.0, 1e-4]):
        cfg = dict(base, batch=256, lr=lr, wd=wd)
        tag = f"target h1={h1} h2={h2} lr={lr} wd={wd}"
        model, best = M.train_target(tt, tv, ns, nc, h1, h2, cfg, log, tag)
        print(f"{tag}: val loss {best['loss']:.4f} acc {best['acc']:.4f} epoch {best['epoch']}", flush=True)
        results.append((best["acc"], -best["loss"], h1, h2, lr, wd, model, best))
    results.sort(key=lambda r: (r[0], r[1]), reverse=True)
    acc, _, h1, h2, lr, wd, model, best = results[0]
    torch.save({"h1": h1, "h2": h2, "h3": 32, "state": model.state_dict()}, os.path.join(OUT, "target.pt"))
    pred, _ = M.target_predict(model, tv)
    t_rep = M.target_report(t_va, pred, maps, openings, schema)
    target_cfg = dict(h1=h1, h2=h2, lr=lr, wd=wd, epoch=best["epoch"], val_acc=acc)

    np.savez(os.path.join(OUT, "norm.npz"), **{f"{k}_{n}": v[i] for k, v in norm.items() for i, n in enumerate(("mean", "inv_std"))})
    M.dump(os.path.join(OUT, "config.json"), {"seed": SEED, "engage": engage_cfg, "target": target_cfg, "base": base})
    with open(os.path.join(OUT, "val_report.txt"), "w", encoding="utf8") as f:
        f.write("== ENGAGE (validation) ==\n" + e_rep["text"] + "\n\n== TARGET (validation) ==\n" + t_rep["text"] + "\n")
    print("\nengage", engage_cfg, "\ntarget", target_cfg, flush=True)
    print(e_rep["text"])
    print(t_rep["text"])


if __name__ == "__main__":
    main()
