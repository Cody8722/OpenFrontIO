"""Small ReLU networks for the nation attack policy, their training loops and
the offline evaluation report.

Every operation in the networks is an add, a multiply or a comparison (ReLU,
max), so they port to deterministic TypeScript inference.

TargetNet: a shared 3-layer scorer gives each candidate a score from
[self features, candidate features]; a separate 2-layer head gives the "no
attack" score from [self features, max over candidates of the scorer's last
hidden layer]. Softmax over [no attack, candidates], cross-entropy.
EngageNet: 3 layers, 3 classes.
"""
import copy
import json

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from nn_data import ENGAGE_CLASSES, MAX_CAND

NEG = -1e9


class TargetNet(nn.Module):
    def __init__(self, ns: int, nc: int, h1: int, h2: int, h3: int = 32) -> None:
        super().__init__()
        self.cs = nn.Linear(nc, h1, bias=False)
        self.ss = nn.Linear(ns, h1)
        self.l2 = nn.Linear(h1, h2)
        self.l3 = nn.Linear(h2, 1)
        self.n1 = nn.Linear(ns + h2, h3)
        self.n2 = nn.Linear(h3, 1)

    def forward(self, s: torch.Tensor, c: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        h = F.relu(self.cs(c) + self.ss(s)[:, None, :])
        h = F.relu(self.l2(h))
        score = self.l3(h).squeeze(-1).masked_fill(~mask, NEG)
        pooled = (h * mask[..., None]).max(1).values  # h >= 0, padding adds 0
        none = self.n2(F.relu(self.n1(torch.cat([s, pooled], 1)))).squeeze(-1)
        return torch.cat([none[:, None], score], 1)


class EngageNet(nn.Module):
    def __init__(self, ns: int, h: int) -> None:
        super().__init__()
        self.l1 = nn.Linear(ns, h)
        self.l2 = nn.Linear(h, h)
        self.l3 = nn.Linear(h, 3)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.l3(F.relu(self.l2(F.relu(self.l1(x)))))


# ---- tensors ---------------------------------------------------------------


def target_tensors(t: dict, norm: dict) -> dict:
    sm, si = norm["self"]
    cm, ci = norm["cand"]
    n = t["n"]
    mask = np.arange(MAX_CAND)[None, :] < n[:, None]
    c = (t["c"] - cm) * ci
    c[~mask] = 0.0
    return dict(
        s=torch.from_numpy((t["s"] - sm) * si),
        c=torch.from_numpy(c.astype(np.float32)),
        mask=torch.from_numpy(mask),
        n=torch.from_numpy(n),
        y=torch.from_numpy(t["y"]),
    )


def engage_tensors(e: dict, norm: dict) -> dict:
    m, i = norm["engage"]
    return dict(x=torch.from_numpy((e["x"] - m) * i), y=torch.from_numpy(e["y"]))


def target_logits(model: TargetNet, d: dict, idx: torch.Tensor) -> torch.Tensor:
    nmax = int(d["n"][idx].max())
    return model(d["s"][idx], d["c"][idx, :nmax], d["mask"][idx, :nmax])


@torch.no_grad()
def target_predict(model: TargetNet, d: dict, chunk: int = 4096) -> tuple[np.ndarray, float]:
    model.eval()
    preds, loss = [], 0.0
    for i in range(0, len(d["y"]), chunk):
        idx = torch.arange(i, min(i + chunk, len(d["y"])))
        lg = target_logits(model, d, idx)
        preds.append(lg.argmax(1).numpy())
        loss += F.cross_entropy(lg, d["y"][idx], reduction="sum").item()
    return np.concatenate(preds), loss / len(d["y"])


@torch.no_grad()
def engage_predict(model: EngageNet, d: dict) -> tuple[np.ndarray, float]:
    model.eval()
    lg = model(d["x"])
    return lg.argmax(1).numpy(), F.cross_entropy(lg, d["y"]).item()


# ---- training --------------------------------------------------------------


def _fit(model, step_loss, predict, n_train, val, cfg, log, tag):
    """Adam, early stopping on validation loss; returns the best state and metrics."""
    g = torch.Generator().manual_seed(cfg["seed"])
    opt = torch.optim.Adam(model.parameters(), lr=cfg["lr"], weight_decay=cfg["wd"])
    best = dict(loss=float("inf"), acc=0.0, epoch=-1, state=None)
    stale = 0
    for epoch in range(cfg["max_epochs"]):
        model.train()
        perm = torch.randperm(n_train, generator=g)
        total = 0.0
        for i in range(0, n_train, cfg["batch"]):
            idx = perm[i : i + cfg["batch"]]
            loss = step_loss(idx)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        pred, vloss = predict(val)
        vacc = float((pred == val["y"].numpy()).mean())
        log({"tag": tag, "epoch": epoch, "train_loss": total / n_train, "val_loss": vloss, "val_acc": vacc})
        if vloss < best["loss"] - 1e-5:
            best = dict(loss=vloss, acc=vacc, epoch=epoch, state=copy.deepcopy(model.state_dict()))
            stale = 0
        else:
            stale += 1
            if stale >= cfg["patience"]:
                break
    model.load_state_dict(best["state"])
    return best


def train_target(tr, va, ns, nc, h1, h2, cfg, log, tag):
    torch.manual_seed(cfg["seed"])
    model = TargetNet(ns, nc, h1, h2)

    def step_loss(idx):
        return F.cross_entropy(target_logits(model, tr, idx), tr["y"][idx])

    best = _fit(model, step_loss, lambda d: target_predict(model, d), len(tr["y"]), va, cfg, log, tag)
    return model, best


def train_engage(tr, va, ns, h, cfg, log, tag):
    torch.manual_seed(cfg["seed"])
    model = EngageNet(ns, h)

    def step_loss(idx):
        return F.cross_entropy(model(tr["x"][idx]), tr["y"][idx])

    best = _fit(model, step_loss, lambda d: engage_predict(model, d), len(tr["y"]), va, cfg, log, tag)
    return model, best


# ---- report ----------------------------------------------------------------

MIN_N = 30


def _acc(pred, y):
    return float((pred == y).mean()) if len(y) else float("nan")


def _cell(pred, y):
    return f"{_acc(pred, y):6.3f} (n={len(y)})"


def baselines(raw: dict, schema: dict) -> dict:
    """Predictions of simple rules, on the unnormalised candidate features."""
    cand = schema["cand"]
    n = raw["n"]
    c = raw["c"]
    mask = np.arange(MAX_CAND)[None, :] < n[:, None]

    def pick(feature, largest):
        v = c[:, :, cand.index(feature)].astype(np.float64)
        v = np.where(mask, v if largest else -v, -np.inf)
        return v.argmax(1) + 1

    return {
        "never attack": np.zeros(len(n), np.int64),
        "weakest candidate": pick("logTheirOverMine", largest=False),
        "longest shared border": pick("logBorderLen", largest=True),
    }


def target_report(raw: dict, pred: np.ndarray, maps: list, openings: list, schema: dict) -> dict:
    y = raw["y"]
    n = raw["n"]
    base = baselines(raw, schema)
    rnd = float((1.0 / (n + 1)).mean())
    out: dict = {"rows": int(len(y))}
    lines = []

    def block(title, groups):
        lines.append(f"\n{title}")
        names = list(base)
        lines.append("  " + "group".ljust(26) + "network".rjust(16) + "".join(b[:18].rjust(22) for b in names))
        for label, m in groups:
            if m.sum() == 0:
                continue
            flag = "  [n<30: 不足以評估]" if m.sum() < MIN_N else ""
            lines.append(
                "  "
                + label.ljust(26)
                + _cell(pred[m], y[m]).rjust(16)
                + "".join(_cell(base[b][m], y[m]).rjust(22) for b in names)
                + flag
            )

    allm = np.ones(len(y), bool)
    block("overall top-1 (incl. no-attack class)", [("all", allm)])
    lines.append(f"  random pick among candidates + no-attack: {rnd:.3f}")
    block("by opening", [(o, raw["meta"][:, 2] == i) for i, o in enumerate(openings)])
    block("by map", [(m, raw["meta"][:, 1] == i) for i, m in enumerate(maps)])
    rules = ["none", "hated", "veryWeak", "juicy", "victim", "crown", "weakest", "island"]
    block("by strategy (label = the rule that attacked)", [(r, raw["rule"] == r) for r in rules])

    attack = y > 0
    out["attack_rows_target_match"] = _acc(pred[attack], y[attack])
    out["attack_rows_predicted_no_attack"] = float((pred[attack] == 0).mean())
    out["none_rows_predicted_attack"] = float((pred[~attack] > 0).mean())
    lines.append(
        f"\nattack rows: target match {out['attack_rows_target_match']:.3f}, "
        f"predicted no-attack {out['attack_rows_predicted_no_attack']:.3f}; "
        f"no-attack rows predicted attack: {out['none_rows_predicted_attack']:.3f}"
    )
    out["overall"] = _acc(pred, y)
    out["text"] = "\n".join(lines)
    return out


def engage_report(raw: dict, pred: np.ndarray, maps: list, openings: list) -> dict:
    y = raw["y"]
    lines = []
    cm = np.zeros((3, 3), np.int64)
    for t, p in zip(y, pred):
        cm[t, p] += 1
    lines.append("confusion matrix (rows = rules' label, columns = network)")
    lines.append("  " + "".ljust(16) + "".join(c.rjust(16) for c in ENGAGE_CLASSES))
    for i, c in enumerate(ENGAGE_CLASSES):
        lines.append("  " + c.ljust(16) + "".join(str(v).rjust(16) for v in cm[i]))
    lines.append(f"overall accuracy {_acc(pred, y):.4f} (n={len(y)})")
    maj = np.bincount(y, minlength=3).argmax()
    lines.append(f"baseline always '{ENGAGE_CLASSES[maj]}': {_acc(np.full(len(y), maj), y):.4f}")
    for i, o in enumerate(openings):
        m = raw["meta"][:, 2] == i
        lines.append(f"  opening {o}: {_cell(pred[m], y[m])}")
    for i, mp in enumerate(maps):
        m = raw["meta"][:, 1] == i
        lines.append(f"  map {mp}: {_cell(pred[m], y[m])}")
    return {"overall": _acc(pred, y), "confusion": cm.tolist(), "text": "\n".join(lines)}


def dump(path: str, obj) -> None:
    with open(path, "w", encoding="utf8") as f:
        json.dump(obj, f, indent=1)
