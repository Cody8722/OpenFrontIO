// Billion-scale nation experiments. Skipped unless FORT_EXP=1:
//   FORT_EXP=1 npx vitest tests/FortressNation.test.ts --run -t "numerics"
//   FORT_EXP=1 npx vitest tests/FortressNation.test.ts --run -t "growth"
//   FORT_EXP=1 npx vitest tests/FortressNation.test.ts --run -t "attack amount"
//   FORT_EXP=1 npx vitest tests/FortressNation.test.ts --run -t "siege"
//   FORT_EXP=1 npx vitest tests/FortressNation.test.ts --run -t "doomsday"
// All of it runs on the real engine rules (EngineConfig, NationExecution); the
// only test-side switches are in SiegeConfig (see util/FortressSiege.ts).
import {
  Difficulty,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { pow } from "@openfront/engine-lib/DetMath";
import { DoomsdayClockExecution } from "@openfront/engine/execution/DoomsdayClockExecution";
import fs from "fs";
import path from "path";
import {
  buildForts,
  DATA_DIR,
  fortPositions,
  logLine,
  NationSiegeResult,
  WavesResult,
  placeCities,
  runNationSiege,
  runWaves,
  SiegeConfig,
  siegeMap,
  siegeWorld,
} from "./util/FortressSiege";

const ENABLED = process.env.FORT_EXP === "1";
const fmt = (n: number) =>
  Math.abs(n) >= 1e9
    ? `${(n / 1e9).toFixed(3)}B`
    : Math.abs(n) >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n.toFixed(0);

const DIFFS = [
  Difficulty.Easy,
  Difficulty.Medium,
  Difficulty.Hard,
  Difficulty.Impossible,
];

function nationSpec(
  label: string,
  extra: Partial<Parameters<typeof runNationSiege>[0]> = {},
): Parameters<typeof runNationSiege>[0] {
  return {
    label,
    nationTroops: 1e9,
    cityLevels: 20000,
    difficulty: Difficulty.Hard,
    defTroops: 1e8,
    fort: "none",
    attackerCols: 600,
    defenderCols: 200,
    rows: 500,
    maxTicks: 3000,
    sampleEvery: 50,
    frameEvery: 0,
    ...extra,
  };
}

describe.skipIf(!ENABLED)("fortress vs billion-scale nation", () => {
  test("numerics: DetMath accuracy, regen and loss terms at 1e8..1e11", () => {
    logLine(`==== numerics ${new Date().toISOString()} ====`);
    // 1. pow() against Math.pow over the troop range.
    let worst = 0;
    for (const e of [0.6, 0.73]) {
      for (let x = 1e3; x <= 1e12; x *= 3.7) {
        const rel = Math.abs(pow(x, e) - Math.pow(x, e)) / Math.pow(x, e);
        worst = Math.max(worst, rel);
      }
    }
    logLine(
      `[numerics] DetMath.pow 對 Math.pow 最大相對誤差(1e3..1e12, 指數 0.6/0.73) = ${worst.toExponential(2)}`,
    );
    expect(worst).toBeLessThan(1e-7);

    // 2. troop cap and regen at huge city counts, per difficulty (nation, 300k tiles).
    const cfg = new SiegeConfig(
      { difficulty: Difficulty.Hard } as never,
      false,
    );
    const tiles = 300_000;
    const base = 2 * (pow(tiles, 0.6) * 1000 + 50000);
    for (const levels of [0, 400, 4000, 10000, 20000]) {
      const raw = base + levels * cfg.cityTroopIncrease();
      logLine(
        `[numerics] 300k格 城市等級=${levels} → 上限(未乘難度)=${fmt(raw)}  Easy×0.5=${fmt(raw * 0.5)} Medium×0.75=${fmt(raw * 0.75)} Hard×1=${fmt(raw)} Impossible×1.25=${fmt(raw * 1.25)}`,
      );
    }

    // 3. attack-loss terms for a 10x attack vs a 1e8 defender on 1e5 plains tiles.
    const lossFor = (
      defTroops: number,
      defTiles: number,
      post: boolean,
      atk = 1e9,
    ) =>
      cfg.attackLogic({
        terrain: TerrainType.Plains,
        attackTroops: atk,
        attacker: { type: PlayerType.Nation, numTiles: 300_000 },
        defender: {
          type: PlayerType.Human,
          numTiles: defTiles,
          troops: defTroops,
          isTraitor: false,
          isDisconnectedTeammate: false,
        },
        defenderHasDefensePost: post,
        falloutRatio: null,
        borderSize: 500,
      });
    for (const [t, n] of [
      [1e8, 1e5],
      [1e9, 1e5],
      [1e8, 1e4],
      [1e10, 1e5],
    ] as const) {
      for (const post of [false, true]) {
        const full = lossFor(t, n, post);
        const noDensity = lossFor(0, n, post);
        const share = 1 - noDensity.attackerTroopLoss / full.attackerTroopLoss;
        logLine(
          `[numerics] 防守兵=${fmt(t)} 格=${n} 密度=${(t / n).toFixed(0)}/格 堡壘=${post} → 每格損失=${full.attackerTroopLoss.toFixed(1)} (不含密度項=${noDensity.attackerTroopLoss.toFixed(1)}) 密度項占比=${(share * 100).toFixed(1)}% 每格兵力=${full.tickFraction.toExponential(2)} 單格tick`,
        );
      }
    }
    // The defender loses exactly its per-tile density on each tile it gives up,
    // so (T - T/N) / (N - 1) = T/N: the density term is constant during a siege.
    const d0 = 1e8 / 1e5;
    const d1 = (1e8 - d0) / (1e5 - 1);
    expect(Math.abs(d1 - d0)).toBeLessThan(1e-9);
    logLine(
      `[numerics] 防守方每失一格就失去 T/N 兵力 → 圍城期間 T/N 不變(1e8/1e5=${d0} → 失1格後 ${d1})`,
    );
  });

  test("growth: nation with many city levels regenerating toward its cap", async () => {
    logLine(`==== growth ${new Date().toISOString()} ====`);
    for (const levels of [4000, 20000]) {
      const m = siegeMap(600, 200, 500);
      const w = await siegeWorld(m, {
        attackerType: PlayerType.Nation,
        config: { difficulty: Difficulty.Hard, nations: "default" },
      });
      placeCities(w, levels);
      w.config.blockBuilds = true;
      const cap = w.config.maxTroops(w.attacker);
      w.attacker.setTroops(1_000_000);
      let t = 0;
      const marks = new Map<number, number>();
      let prev = w.attacker.troops();
      let prevTick = 0;
      let violations = 0;
      while (t < 12000) {
        w.game.executeNextTick();
        t++;
        const now = w.attacker.troops();
        if (!Number.isInteger(now) || now > cap) violations++;
        for (const frac of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9]) {
          if (!marks.has(frac) && now >= cap * frac) marks.set(frac, t);
        }
        if (t % 1000 === 0) {
          logLine(
            `[growth] 城市等級=${levels} 上限=${fmt(cap)} t=${t} 兵=${fmt(now)} (${((now / cap) * 100).toFixed(1)}%) 近1000tick平均回復=${fmt((now - prev) / (t - prevTick))}/tick`,
          );
          prev = now;
          prevTick = t;
        }
      }
      logLine(
        `[growth] 城市等級=${levels} 上限=${fmt(cap)} 達 1%/10%/25%/50%/75%/90% 上限所需 tick: ${[0.01, 0.1, 0.25, 0.5, 0.75, 0.9].map((f) => `${f * 100}%→${marks.get(f) ?? "未達"}`).join("  ")}  (一秒=10 tick) 整數/上限違規=${violations}`,
      );
      expect(violations).toBe(0);
    }
  }, 600_000);

  test("attack amount: what NationExecution sends at 1e9 and 3e9 troops", async () => {
    logLine(`==== attack amount ${new Date().toISOString()} ====`);
    for (const troops of [1e9, 3e9]) {
      for (const diff of DIFFS) {
        const r = await runNationSiege(
          nationSpec(`amt-${fmt(troops)}-${diff}`, {
            nationTroops: troops,
            difficulty: diff,
            maxTicks: 600,
            sampleEvery: 100,
          }),
        );
        const first = r.attacks[0];
        logLine(
          `[amount] nation兵=${fmt(troops)} 上限=${fmt(r.nationCap)} 難度=${diff} → 第一次進攻 ${first ? `t=${first.tick} 投入=${fmt(first.troops)} (${((first.troops / troops) * 100).toFixed(0)}% 兵力, ${(first.troops / 1e8).toFixed(1)}x 防守兵)` : "沒有進攻"} 共 ${r.attacks.length} 次`,
        );
      }
    }
  }, 900_000);

  test("siege: 1e8 defender with fortress lattices vs a 1e9 nation", async () => {
    logLine(`==== siege ${new Date().toISOString()} ====`);
    const out: NationSiegeResult[] = [];
    for (const fort of ["none", "lat42", "lat30", "lat21"] as const) {
      out.push(
        await runNationSiege(
          nationSpec(`siege-${fort}`, {
            fort,
            frameEvery: 100,
            maxTicks: 3000,
          }),
        ),
      );
    }
    logLine(
      "---- siege 對照(防守 1e8,5層堡壘=整片格狀;nation 1e9,Hard,真實 NationExecution) ----",
    );
    for (const r of out) {
      const sent = r.attacks.reduce((s, a) => s + a.troops, 0);
      logLine(
        `${r.spec.fort.padEnd(6)} | 堡壘 ${String(r.posts0).padStart(3)} | 失地 ${(r.lostFrac * 100).toFixed(1)}% | 50%@${r.tickTo50 ?? "-"} 100%@${r.tickTo100 ?? "-"} tick | 進攻 ${r.attacks.length} 次共 ${fmt(sent)} | 進攻方損失 ${fmt(r.nationLoss)} | 防守兵 ${fmt(r.defTroops0)}→${fmt(r.defTroopsEnd)} | 密度項占比 ${(r.densityShare * 100).toFixed(1)}% | 被奪格有堡壘 ${(r.effCoverage * 100).toFixed(1)}% | ${r.endReason}`,
      );
    }
    fs.writeFileSync(
      path.join(DATA_DIR, "nation-siege.json"),
      JSON.stringify(out.map((r) => ({ ...r, frames: [] }))),
    );
  }, 1_800_000);

  test("forced: one identical 1e9 attack against 1e8 and 5e8 defenders", async () => {
    logLine(`==== forced ${new Date().toISOString()} ====`);
    const out: NationSiegeResult[] = [];
    for (const defTroops of [1e8, 5e8]) {
      for (const fort of ["none", "lat42", "lat30", "lat21"] as const) {
        out.push(
          await runNationSiege(
            nationSpec(`forced-${fmt(defTroops)}-${fort}`, {
              fort,
              defTroops,
              nationTroops: 1.2e9,
              forceAllIn: 1e9,
              frameEvery: defTroops === 1e8 ? 100 : 0,
              maxTicks: 4000,
            }),
          ),
        );
      }
    }
    logLine(
      "---- forced 對照(一次投入 1e9,防守兵力會補充;Nation 兵 1.2e9) ----",
    );
    for (const r of out) {
      logLine(
        `防守${fmt(r.defTroops0).padEnd(8)} ${r.spec.fort.padEnd(5)} | 堡壘 ${String(r.posts0).padStart(3)} | 失地 ${(r.lostFrac * 100).toFixed(1)}% | 50%@${r.tickTo50 ?? "-"} 100%@${r.tickTo100 ?? "-"} | 進攻方損失 ${fmt(r.nationLoss)} | 防守兵 ${fmt(r.defTroops0)}→${fmt(r.defTroopsEnd)} | 密度項 ${(r.densityShare * 100).toFixed(1)}% | 被奪格有堡壘 ${(r.effCoverage * 100).toFixed(1)}% | ${r.endReason} t=${r.ticks}`,
      );
    }
    fs.writeFileSync(
      path.join(DATA_DIR, "nation-forced.json"),
      JSON.stringify(out.map((r) => ({ ...r, frames: [] }))),
    );
  }, 3_600_000);

  test("breakeven: how many defender troops stop one 1e9 attack (lat21)", async () => {
    logLine(`==== breakeven ${new Date().toISOString()} ====`);
    for (const defTroops of [6e8, 8e8, 1e9, 1.5e9]) {
      for (const fort of ["none", "lat21"] as const) {
        const r = await runNationSiege(
          nationSpec(`be-${fmt(defTroops)}-${fort}`, {
            fort,
            defTroops,
            nationTroops: 1.2e9,
            forceAllIn: 1e9,
            maxTicks: 4000,
          }),
        );
        logLine(
          `[breakeven] 防守${fmt(defTroops)} ${fort} → 失地 ${(r.lostFrac * 100).toFixed(1)}% 進攻方損失 ${fmt(r.nationLoss)} 防守兵末 ${fmt(r.defTroopsEnd)} ${r.endReason} t=${r.ticks}`,
        );
      }
    }
  }, 3_600_000);

  test("waves: 10 minutes of real NationExecution attacks, fort vs none, 30 vs 21", async () => {
    logLine(`==== waves ${new Date().toISOString()} ====`);
    const seeds = (process.env.FORT_WAVE_SEEDS ?? "1").split(",").map(Number);
    // FORT_WAVE_FULL=1: the defender starts at its cap instead of 1e8.
    const full = process.env.FORT_WAVE_FULL === "1";
    const diff =
      (process.env.FORT_WAVE_DIFF as Difficulty | undefined) ?? Difficulty.Hard;
    const dtag = diff === Difficulty.Hard ? "" : `-${diff}`;
    const out: WavesResult[] = [];
    for (const seed of seeds) {
      for (const defCap of [2e8, 4e8]) {
        for (const fort of ["none", "lat30", "lat21"] as const) {
          out.push(
            await runWaves({
              label: `w${fmt(defCap)}-${fort}-s${seed}${full ? "-full" : ""}${dtag}`,
              seed,
              nationTroops: 2e8,
              nationCap: 4e8,
              difficulty: diff,
              defTroops: full ? defCap : 1e8,
              defCap,
              fort,
              maxTicks: 6000,
              sampleEvery: 10,
              attackerCols: 600,
              defenderCols: 200,
              rows: 500,
            }),
          );
        }
      }
    }
    logLine("---- waves 對照(我方 1e8 兵,nation 2e8/上限 4e8,10 分鐘) ----");
    for (const r of out) {
      const sizes = r.waves.map((x) => fmt(x.troops)).join(",");
      const gaps = r.waves
        .slice(1)
        .map((x) => x.interval)
        .join(",");
      logLine(
        `${r.spec.label.padEnd(18)} | 堡壘 ${String(r.posts0).padStart(3)}→${String(r.postsEnd).padStart(3)} | ${r.waves.length} 波 投入[${sizes}] 間隔tick[${gaps}] | 領土 100%→${((r.defTilesEnd / 100000) * 100).toFixed(1)}% | 領土<50%@${r.tickTiles50 ?? "-"} 兵<進行中攻擊@${r.tickBelowAttack ?? "-"} 兵<上一波@${r.tickBelowLastWave ?? "-"} 滅亡@${r.tickDead ?? "-"}`,
      );
    }
  }, 3_600_000);

  test("doomsday: troop floor and drain when max troops is huge", async () => {
    logLine(`==== doomsday ${new Date().toISOString()} ====`);
    // A small defender (below every bar) next to a big leader, clock enabled,
    // run past the 10-minute grace. Compare max-troops small vs huge (cities).
    for (const cityLevels of [0, 20000]) {
      // 20x100 = 2000 of ~62000 tiles = 3.2%: under the 5% bar the "fast" clock
      // reaches by 900 s, so this side is doomed; the attacker is the leader.
      const m = siegeMap(600, 20, 100);
      const w = await siegeWorld(m, {
        config: {
          // infiniteTroops would pin a human's cap at 1e9 and hide the cities.
          infiniteTroops: false,
          doomsdayClock: { enabled: true, speed: "fast" },
        } as never,
      });
      // GameRunner adds this in a real game; a bare createGame does not.
      w.game.addExecution(new DoomsdayClockExecution());
      if (cityLevels > 0) {
        const spots = [];
        for (let y = 20; y < 100; y += 20)
          for (let x = m.frontX + 5; x < m.frontX + 20; x += 20)
            spots.push([x, y]);
        const units = spots.map(([x, y]) =>
          w.defender.buildUnit(UnitType.City, w.game.ref(x, y), {}),
        );
        for (
          let i = 0, left = cityLevels - units.length;
          left > 0;
          i = (i + 1) % units.length, left--
        )
          units[i].increaseLevel();
      }
      const cap = w.config.maxTroops(w.defender);
      w.defender.setTroops(Math.floor(cap * 0.5));
      w.config.frozenRegen.add("defender"); // isolate the clock's effect
      const start = w.defender.troops();
      let flaggedAt: number | null = null;
      let firstDrainAt: number | null = null;
      let last = start;
      for (let t = 1; t <= 9000; t++) {
        w.game.executeNextTick();
        const now = w.defender.troops();
        if (flaggedAt === null && w.defender.inDoomsdayClock()) flaggedAt = t;
        if (firstDrainAt === null && now < last) firstDrainAt = t;
        last = now;
      }
      logLine(
        `[doomsday] 防守城市等級=${cityLevels} 上限=${fmt(cap)} 起始兵=${fmt(start)}(50%) 9000tick(15分鐘)後=${fmt(last)} 首次標記@${flaggedAt} 首次扣兵@${firstDrainAt} 約 5% 下限=${fmt(cap * 0.05)}`,
      );
    }
  }, 600_000);

  test("fort build sanity: 5 columns at 42 cover the 200-wide defender", async () => {
    const m = siegeMap(600, 200, 500);
    const pts = fortPositions(m, "lat42");
    const cols = new Set(pts.map((p) => p.x)).size;
    expect(cols).toBe(5);
    const w = await siegeWorld(m);
    expect(buildForts(w, pts)).toBe(pts.length);
  }, 120_000);
});
