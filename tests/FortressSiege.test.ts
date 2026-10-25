// Fortress siege experiment. Skipped unless FORT_EXP=1:
//   FORT_EXP=1 npx vitest tests/FortressSiege.test.ts --run -t "minimal"
//   FORT_EXP=1 npx vitest tests/FortressSiege.test.ts --run -t "matrix"
// Knobs: FORT_COMMIT (attack troops, default 1e8), FORT_MAXTICKS (default 6000),
// FORT_VARIANTS=1 adds the diagnosis runs (regen on, band layout).
import fs from "fs";
import path from "path";
import {
  buildSiegeReport,
  DATA_DIR,
  fortPositions,
  logLine,
  modelSiege,
  runSiege,
  SiegeConfig,
  siegeMap,
  SiegeResult,
  SiegeSpec,
  siegeWorld,
} from "./util/FortressSiege";

const ENABLED = process.env.FORT_EXP === "1";
const COMMIT = Number(process.env.FORT_COMMIT ?? 1e8);
const MAX_TICKS = Number(process.env.FORT_MAXTICKS ?? 6000);

// What the request predicted (share of the defender's tiles lost).
const PREDICTED: Record<number, { none: number; full: number }> = {
  1: { none: 1.0, full: 0.42 },
  2: { none: 0.77, full: 0.15 },
  4: { none: 0.39, full: 0.08 },
};

function bigSpec(
  label: string,
  defMult: number,
  fort: SiegeSpec["fort"],
  extra: Partial<SiegeSpec> = {},
): SiegeSpec {
  return {
    label,
    commit: COMMIT,
    defMult,
    fort,
    defRegen: false,
    attackerCols: 600,
    defenderCols: 200,
    rows: 500,
    maxTicks: MAX_TICKS,
    sampleEvery: 100,
    frameEvery: 100,
    ...extra,
  };
}

function modelFor(spec: SiegeSpec, r: SiegeResult, covered = r.coverage) {
  const cfg = new SiegeConfig(
    {
      gameMap: 0 as never,
    } as never,
    false,
  );
  return modelSiege(
    cfg,
    r.committed,
    r.defTroops0,
    r.defTiles0,
    r.atkTiles0,
    covered,
    spec.rows + 2,
  );
}

describe.skipIf(!ENABLED)("fortress siege", () => {
  test("minimal: state is readable and regeneration can be switched off", async () => {
    logLine(`==== minimal ${new Date().toISOString()} ====`);
    const m = siegeMap(60, 40, 100);
    const w = await siegeWorld(m);
    w.defender.setTroops(1_000_000);
    const before = w.defender.troops();
    for (let i = 0; i < 30; i++) w.game.executeNextTick();
    const regenOn = w.defender.troops();
    w.config.frozenRegen.add("defender");
    for (let i = 0; i < 30; i++) w.game.executeNextTick();
    const regenOff = w.defender.troops();
    logLine(
      `[minimal] 防守兵 設定=${before} 30tick後(補充開)=${regenOn} 再30tick(補充關)=${regenOff}`,
    );
    expect(regenOn).toBeGreaterThan(before);
    expect(regenOff).toBe(regenOn);
    expect(w.defender.numTilesOwned()).toBe(40 * 100);
    expect(w.attacker.numTilesOwned()).toBe(60 * 100);
    expect(fortPositions(m, "full").length).toBeGreaterThan(0);

    const small = (label: string, fort: SiegeSpec["fort"]): SiegeSpec => ({
      label,
      commit: 1_000_000,
      defMult: 1,
      fort,
      defRegen: false,
      attackerCols: 60,
      defenderCols: 40,
      rows: 100,
      maxTicks: 600,
      sampleEvery: 50,
      frameEvery: 50,
    });
    const none = await runSiege(small("minimal-none", "none"));
    const full = await runSiege(small("minimal-full", "full"));
    for (const r of [none, full]) {
      const mdl = modelFor(r.spec, r);
      logLine(
        `[minimal] ${r.spec.label} 失地=${(r.lostFrac * 100).toFixed(1)}% 每格=${r.lossPerTile.toFixed(0)} | 模型 首格=${mdl.firstTileLoss.toFixed(0)} 積分失地=${(mdl.frac * 100).toFixed(1)}% 靜態=${((mdl.staticTiles / r.defTiles0) * 100).toFixed(1)}%`,
      );
    }
    expect(none.committed).toBe(1_000_000);
    expect(none.lostTiles).toBeGreaterThan(0);
    expect(full.posts0).toBeGreaterThan(0);
    // 100 rows do not divide into the 42-tile lattice (the full map does: 100%).
    expect(full.coverage).toBeGreaterThan(0.9);
    // A fortress must make the same attack take fewer tiles.
    expect(full.lostTiles).toBeLessThan(none.lostTiles);
  }, 600_000);

  test("matrix: 3 defender sizes x with/without fortress", async () => {
    logLine(`==== matrix commit=${COMMIT} ${new Date().toISOString()} ====`);
    const rows: string[] = [];
    const results: { res: SiegeResult; model: ReturnType<typeof modelFor> }[] =
      [];
    for (const mult of [1, 2, 4]) {
      for (const fort of ["none", "full"] as const) {
        const spec = bigSpec(`m${mult}x-${fort}`, mult, fort);
        const res = await runSiege(spec);
        const model = modelFor(spec, res);
        const modelEff = modelFor(spec, res, res.effCoverage);
        results.push({ res, model });
        const pred = PREDICTED[mult][fort];
        rows.push(
          `防守${mult}x ${fort.padEnd(4)} | 實測失地 ${(res.lostFrac * 100).toFixed(1)}% | 推算 ${(pred * 100).toFixed(0)}% | 積分(涵蓋100%) ${(model.frac * 100).toFixed(1)}% | 積分(用實測涵蓋 ${(res.effCoverage * 100).toFixed(1)}%) ${(modelEff.frac * 100).toFixed(1)}% | 靜態 ${((model.staticTiles / res.defTiles0) * 100).toFixed(1)}% | 實測每格 ${res.lossPerTile.toFixed(0)} | 首格 ${model.firstTileLoss.toFixed(0)} | 結束 ${res.endReason} t=${res.ticks}`,
        );
      }
    }
    logLine("---- matrix 對照 ----");
    for (const r of rows) logLine(r);
    fs.writeFileSync(
      path.join(DATA_DIR, "matrix.json"),
      JSON.stringify(results),
    );
    expect(results.length).toBe(6);
  }, 3_600_000);

  test("spacing: lattice 42 / 30 / 21 in the original 1e8-attack scenario", async () => {
    logLine(`==== spacing commit=${COMMIT} ${new Date().toISOString()} ====`);
    const rows: string[] = [];
    for (const mult of [1, 2, 4]) {
      for (const fort of ["none", "lat42", "lat30", "lat21"] as const) {
        const res = await runSiege(bigSpec(`s${mult}x-${fort}`, mult, fort));
        rows.push(
          `防守${mult}x ${fort.padEnd(5)} | 堡壘 ${String(res.posts0).padStart(3)} | 涵蓋 ${(res.coverage * 100).toFixed(1)}% | 被奪格實際涵蓋 ${(res.effCoverage * 100).toFixed(1)}% | 失地 ${(res.lostFrac * 100).toFixed(1)}% | 每格損失 ${res.lossPerTile.toFixed(0)} | 結束 ${res.endReason} t=${res.ticks}`,
        );
      }
    }
    logLine("---- spacing 對照(進攻 1e8 實投,防守兵力不補充) ----");
    for (const r of rows) logLine(r);
  }, 3_600_000);

  test("report: one HTML page from every saved run", () => {
    const file = buildSiegeReport(
      path.join(DATA_DIR, "fortress-siege-report.html"),
    );
    logLine(`[report] ${file}`);
    expect(fs.existsSync(file)).toBe(true);
  });

  test.skipIf(process.env.FORT_VARIANTS !== "1")(
    "variants: regeneration on, band layout",
    async () => {
      logLine(
        `==== variants commit=${COMMIT} ${new Date().toISOString()} ====`,
      );
      const out: SiegeResult[] = [];
      for (const mult of [1, 2]) {
        out.push(
          await runSiege(
            bigSpec(`v${mult}x-full-regen`, mult, "full", { defRegen: true }),
          ),
        );
        out.push(await runSiege(bigSpec(`v${mult}x-band`, mult, "band")));
      }
      logLine("---- variants ----");
      for (const r of out) {
        logLine(
          `${r.spec.label} | 失地 ${(r.lostFrac * 100).toFixed(1)}% | 涵蓋 ${(r.coverage * 100).toFixed(1)}% | 每格 ${r.lossPerTile.toFixed(0)} | 防守兵 ${r.defTroops0}→${r.defTroopsEnd} | ${r.endReason} t=${r.ticks}`,
        );
      }
      fs.writeFileSync(
        path.join(DATA_DIR, "variants.json"),
        JSON.stringify(out),
      );
    },
    3_600_000,
  );
});
