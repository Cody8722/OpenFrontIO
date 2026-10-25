// Can nukes shrink a billion-scale attack? Skipped unless FORT_EXP=1:
//   FORT_EXP=1 npx vitest tests/FortressNuke.test.ts --run -t "effect"
//   ... -t "corridor" | "saturation" | "graze" | "needed"
// Real engine rules; logs in .fortress-siege-data/nuke/nuke.log. Run one test
// at a time: they are CPU heavy and starve a running real game.
import {
  Difficulty,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import fs from "fs";
import path from "path";
import {
  blastTiles,
  denseSams,
  fmtN,
  nationBox,
  nlog,
  NUKE_DIR,
  NukePlanItem,
  NukeScenario,
  overlapStats,
  placeSams,
  PRICE,
  reachMap,
  renderReach,
  runNukeScenario,
  Sam,
  sparseSams,
  troopFactor,
} from "./util/FortressNuke";
import { siegeMap, siegeWorld } from "./util/FortressSiege";

const ENABLED = process.env.FORT_EXP === "1";
const H = {
  type: UnitType.HydrogenBomb,
  name: "氫彈",
  inner: 80,
  outer: 100,
} as const;
const A = {
  type: UnitType.AtomBomb,
  name: "原子彈",
  inner: 12,
  outer: 30,
} as const;
const NATION_TILES = 300_000;
// infiniteTroops off for the defender: its cap comes from cities. 400 levels =
// 2.1M + 400 * 250k = ~102M, just above its 1e8 troops.
const DEF_LEVELS = 400;

/** Silo spots on our land (x 625..795, y 20..500, 20 apart). */
function siloSpots(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 20; y <= 500; y += 20) {
    for (let x = 625; x <= 795; x += 20) out.push({ x, y });
  }
  return out;
}

/** A SAM mix like the real nations built (levels per bucket), placed at random. */
function mixedSams(seed: number, hist: [number, number, number][]): Sam[] {
  const m = siegeMap(600, 200, 500);
  const total = hist.reduce((a, h) => a + h[0], 0);
  const base = sparseSams(m, seed, total, 1, 1);
  let i = 0;
  let s = seed;
  const r = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (const [count, lo, hi] of hist) {
    for (let k = 0; k < count; k++) {
      base[i++].level = lo + Math.floor(r() * (hi - lo + 1));
    }
  }
  return base;
}

// Real nations seen in the real game (step 1): "Chad" 24 SAMs, "Cuba" 12.
const REAL24: [number, number, number][] = [
  [8, 1, 3],
  [7, 4, 10],
  [7, 11, 50],
  [2, 51, 87],
];
const REAL12: [number, number, number][] = [
  [2, 1, 3],
  [10, 11, 50],
];
// Late game (real run, minute 38.7): "Latvia" 46 SAMs, level sum 3945, one SAM at level 1159.
const LATE46: [number, number, number][] = [
  [8, 1, 3],
  [7, 4, 10],
  [20, 11, 50],
  [8, 51, 300],
  [3, 301, 1200],
];

async function layouts() {
  const m = siegeMap(600, 200, 500);
  const w0 = await siegeWorld(m, { attackerType: PlayerType.Nation });
  const rangeOf = (l: number) => w0.config.samRange(l);
  const dense = denseSams(m, rangeOf, 50, 5);
  nlog(
    `[layout] dense: SAM 等級50 格狀間距=${dense.spacing} 共${dense.sams.length}座(等級和 ${dense.sams.length * 50}) 最少重疊=${dense.minCover} 射程(L50)=${rangeOf(50).toFixed(1)}`,
  );
  const sets: Record<string, Sam[]> = {
    none: [],
    sparse: sparseSams(m, 7, 12, 1, 3),
    real12: mixedSams(11, REAL12),
    real24: mixedSams(13, REAL24),
    late46: mixedSams(17, LATE46),
    dense: dense.sams,
  };
  return { m, sets, rangeOf };
}

describe.skipIf(!ENABLED)("fortress nukes", () => {
  test("effect: troop cut per bomb, no SAM, by target place", async () => {
    nlog(`==== effect ${new Date().toISOString()} ====`);
    nlog(
      "[假設] 削兵比例只取決於『命中格佔該國領土比例』: 剩餘 ≈ ((N-k)/N)^5;氫彈打內陸最大,邊緣/角落因為海外面積無效而較小;原子彈小很多",
    );
    const targets: [string, number, number][] = [
      ["內陸", 300, 260],
      ["西緣", 20, 260],
      ["西北角", 20, 20],
      ["北緣", 300, 20],
      ["前線", 590, 260],
    ];
    for (const bomb of [H, A]) {
      for (const [name, tx, ty] of targets) {
        const plan: NukePlanItem = {
          tick: 5,
          type: bomb.type,
          tx,
          ty,
          silo: { x: 700, y: Math.min(480, Math.max(30, ty)) },
        };
        const r = await runNukeScenario({
          label: `effect-${bomb.name}-${name}`,
          nationTroops: 1.2e9,
          cityLevels: 1584,
          difficulty: Difficulty.Hard,
          defTroops: 1e8,
          defCityLevels: DEF_LEVELS,
          fort: "none",
          forcedAttack: 1e9,
          sams: [],
          nukes: [plan],
          frozenNationRegen: true,
          maxTicks: 150,
          sampleEvery: 1,
        });
        const f = r.fates[0];
        const e = f.endTick ?? 0;
        const b = r.samples[Math.max(0, e - 1)];
        const a = r.samples[Math.min(r.samples.length - 1, e)];
        const k = blastTiles(
          siegeMap(600, 200, 500),
          tx,
          ty,
          bomb.inner,
          bomb.outer,
        );
        nlog(
          `[effect] ${bomb.name} ${name}(${tx},${ty}) ${f.fate}@t=${e} nation格 ${b.nationTiles}→${a.nationTiles}(毀 ${b.nationTiles - a.nationTiles}) 池 ${fmtN(b.pool)}→${fmtN(a.pool)} ×${(a.pool / b.pool).toFixed(3)} 進攻 ${fmtN(b.attack)}→${fmtN(a.attack)} ×${(a.attack / b.attack).toFixed(3)} 預測 ×${troopFactor(NATION_TILES, k).toFixed(3)}(預期命中 ${k.toFixed(0)} 格)`,
        );
      }
    }
    // Hitting the same ground twice: the second bomb finds fewer tiles.
    const two: NukePlanItem[] = [5, 15].map((tick) => ({
      tick,
      type: H.type,
      tx: 300,
      ty: 260,
      silo: { x: 700 + (tick > 5 ? 20 : 0), y: 260 },
    }));
    const r2 = await runNukeScenario({
      label: "effect-氫彈x2-同一點",
      nationTroops: 1.2e9,
      cityLevels: 1584,
      difficulty: Difficulty.Hard,
      defTroops: 1e8,
      defCityLevels: DEF_LEVELS,
      fort: "none",
      forcedAttack: 1e9,
      sams: [],
      nukes: two,
      frozenNationRegen: true,
      maxTicks: 160,
      sampleEvery: 1,
    });
    for (const f of r2.fates) {
      const e = f.endTick ?? 0;
      const b = r2.samples[Math.max(0, e - 1)];
      const a = r2.samples[Math.min(r2.samples.length - 1, e)];
      nlog(
        `[effect] 氫彈x2同一點 第${f.plan.tick === 5 ? 1 : 2}發 ${f.fate}@t=${e} 池 ×${(a.pool / b.pool).toFixed(3)} 進攻 ×${(a.attack / b.attack).toFixed(3)}`,
      );
    }
  }, 1_800_000);

  test("corridor: where can one bomb get in, by SAM layout", async () => {
    nlog(`==== corridor ${new Date().toISOString()} ====`);
    nlog(
      "[假設] 全境 SAM(平均50級、重疊>=5)下幾乎沒有可進入的格子;零星 SAM 下大半可進入;邊緣與沿海比內陸更容易進入",
    );
    const { m, sets, rangeOf } = await layouts();
    const silos = [
      { x: 625, y: 60 },
      { x: 625, y: 250 },
      { x: 625, y: 440 },
      { x: 710, y: 250 },
      { x: 800, y: 60 },
      { x: 800, y: 250 },
      { x: 800, y: 440 },
    ];
    const step = 12;
    for (const [name, sams] of Object.entries(sets)) {
      const w = await siegeWorld(m, { attackerType: PlayerType.Nation });
      const units = placeSams(w, sams, false);
      for (let i = 0; i < 70; i++) w.game.executeNextTick(); // finish the 45-tick upgrade ramp
      const st = sams.length ? overlapStats(m, sams, rangeOf, 5) : null;
      const ov = st
        ? `覆蓋領土 ${(st.covered * 100).toFixed(0)}% 其中>=5座 ${(st.coveredK * 100).toFixed(0)}%`
        : "無 SAM";
      for (const bomb of [H, A]) {
        const cells = reachMap(
          w,
          units,
          silos,
          step,
          bomb.inner,
          bomb.outer,
          10,
        );
        renderReach(
          w,
          cells,
          step,
          sams,
          silos,
          path.join(NUKE_DIR, `reach-${name}-${bomb.name}.png`),
        );
        const row = (cls: string) => {
          const set = cells.filter((c) => cls === "all" || c.cls === cls);
          const free = set.filter((c) => c.free);
          const best = free.length
            ? Math.min(...free.map((c) => c.factor))
            : NaN;
          const mean = free.length
            ? free.reduce((a, c) => a + c.factor, 0) / free.length
            : NaN;
          return `${cls} ${free.length}/${set.length}=${((free.length / Math.max(1, set.length)) * 100).toFixed(0)}% 最強×${best.toFixed(3)} 平均×${mean.toFixed(3)}`;
        };
        nlog(
          `[corridor] ${name}(SAM ${sams.length}座 等級和 ${sams.reduce((a, s) => a + s.level, 0)}; ${ov}) ${bomb.name}: ${row("all")} | ${row("front")} | ${row("edge")} | ${row("interior")}`,
        );
        fs.writeFileSync(
          path.join(NUKE_DIR, `reach-${name}-${bomb.name}.json`),
          JSON.stringify({ name, bomb: bomb.name, step, sams, silos, cells }),
        );
      }
    }
  }, 3_600_000);

  test("saturation: N nukes at once against each SAM layout", async () => {
    nlog(`==== saturation ${new Date().toISOString()} ====`);
    nlog(
      "[假設] 一次丟的核彈數超過可達 SAM 的彈匣總數時才會漏;sparse 幾十發就破,real24(等級和約330)要數百發,dense(等級和約2000)根本破不了",
    );
    const { sets } = await layouts();
    const spots = siloSpots();
    const b = nationBox(siegeMap(600, 200, 500));
    // FORT_SAT_NS="5,10,..." FORT_SAT_BOMBS="H"|"A" FORT_SAT_CFGS="real24,dense" narrow the sweep.
    const satNs = (process.env.FORT_SAT_NS ?? "20,50,100,200")
      .split(",")
      .map(Number);
    const satBombs = (process.env.FORT_SAT_BOMBS ?? "A,H")
      .split(",")
      .map((k) => (k === "A" ? A : H));
    const satCfgs = (process.env.FORT_SAT_CFGS ?? "sparse,real24,dense").split(
      ",",
    ) as ("sparse" | "real24" | "dense" | "real12" | "late46")[];
    for (const bomb of satBombs) {
      for (const cfgName of satCfgs) {
        for (const N of satNs) {
          // spread targets over the whole land: a grid
          const cols = Math.ceil(
            Math.sqrt((N * (b.x1 - b.x0)) / (b.y1 - b.y0)),
          );
          const rows = Math.ceil(N / cols);
          const targets: { x: number; y: number }[] = [];
          for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
              targets.push({
                x: Math.round(
                  b.x0 + 15 + ((i + 0.5) / cols) * (b.x1 - b.x0 - 30),
                ),
                y: Math.round(
                  b.y0 + 15 + ((j + 0.5) / rows) * (b.y1 - b.y0 - 30),
                ),
              });
            }
          }
          const plan: NukePlanItem[] = targets.slice(0, N).map((t, i) => ({
            tick: 5,
            type: bomb.type,
            tx: t.x,
            ty: t.y,
            silo: spots[i % spots.length],
          }));
          const sc: NukeScenario = {
            label: `sat-${bomb.name}-${cfgName}-N${N}`,
            nationTroops: 1.2e9,
            cityLevels: 1584,
            difficulty: Difficulty.Hard,
            defTroops: 1e8,
            defCityLevels: DEF_LEVELS,
            fort: "lat30",
            forcedAttack: 1e9,
            sams: sets[cfgName],
            nukes: plan,
            frozenNationRegen: true,
            tinyBlast: process.env.FORT_SAT_TINY === "1",
            maxTicks: 400,
            sampleEvery: 5,
          };
          const r = await runNukeScenario(sc);
          const landed = r.fates.filter((f) => f.fate === "landed");
          const firstLand = Math.min(...landed.map((f) => f.endTick ?? 1e9));
          const lastLand = Math.max(0, ...landed.map((f) => f.endTick ?? 0));
          const before = landed.length
            ? r.samples.filter((x) => x.tick < firstLand).pop()
            : undefined;
          const after = landed.length
            ? r.samples.find((x) => x.tick >= lastLand)
            : undefined;
          nlog(
            `[saturation] ${bomb.name} ${cfgName} N=${N}: 落地 ${r.landed} 攔截 ${r.intercepted} (漏彈率 ${((r.landed / N) * 100).toFixed(0)}%) SAM飛彈 ${r.samMissiles} 進攻 ${fmtN(before?.attack ?? NaN)}→${fmtN(after?.attack ?? NaN)} 池 ${fmtN(before?.pool ?? NaN)}→${fmtN(after?.pool ?? NaN)} nation格 ${r.nationTilesStart}→${r.nationTilesEnd} 我方失地 ${(r.lostFrac * 100).toFixed(0)}% 成本 ${fmtN(r.cost.gold)} 金幣(核彈 ${fmtN(r.cost.atoms * PRICE.atom + r.cost.hydrogens * PRICE.hydrogen)} + 飛彈井 ${r.cost.siloLevels} 層)`,
          );
        }
      }
    }
  }, 7_200_000);

  test("graze: low-level SAM out-ranged by a hydrogen bomb's blast", async () => {
    nlog(`==== graze ${new Date().toISOString()} ====`);
    nlog(
      "[假設] 只有 SAM 射程 < 氫彈爆炸半徑(100)的 1~4 級(射程 70/81/90/97)才可能被擦邊打掉:炸點離 SAM 的距離落在 (射程, 100) 之間,且接近方向不穿過 SAM 圈;原子彈(半徑30)不可能",
    );
    const small = siegeMap(300, 100, 300);
    const w0 = await siegeWorld(small, { attackerType: PlayerType.Nation });
    const rangeOf = (l: number) => w0.config.samRange(l);
    const TX = 200;
    const TY = 150;
    for (const L of [1, 2, 3, 4, 5, 6]) {
      const r = rangeOf(L);
      nlog(
        `[graze] L${L} 射程=${r.toFixed(1)} 氫彈建築半徑=100 原子彈=30 → 射程<100? ${r < 100}`,
      );
      const dists = [
        Math.floor(r) - 8,
        Math.ceil(r) + 2,
        Math.min(99, Math.ceil(r) + 12),
        99,
        101,
      ];
      for (const d of [...new Set(dists)].filter((x) => x > 5)) {
        let ok = 0;
        let silent = 0;
        let silentAndKilled = 0;
        let intercepted = 0;
        for (let deg = 0; deg < 360; deg += 30) {
          const sx = Math.round(TX + d * Math.cos((deg * Math.PI) / 180));
          const sy = Math.round(TY + d * Math.sin((deg * Math.PI) / 180));
          const res = await runNukeScenario({
            label: `graze-L${L}-d${d}-a${deg}`,
            nationTroops: 1e8,
            cityLevels: 10,
            difficulty: Difficulty.Hard,
            defTroops: 1e8,
            fort: "none",
            sams: [{ x: sx, y: sy, level: L }],
            nukes: [
              {
                tick: 80,
                type: H.type,
                tx: TX,
                ty: TY,
                silo: { x: 330, y: TY },
              },
            ],
            frozenNationRegen: true,
            attackerCols: 300,
            defenderCols: 100,
            rows: 300,
            maxTicks: 220,
            sampleEvery: 50,
          });
          if (res.landed === 1) ok++;
          else intercepted++;
          // a bomb that landed while the SAM never fired = the SAM could not lock it
          if (res.landed === 1 && res.samMissiles === 0) {
            silent++;
            if (res.samsAliveEnd === 0) silentAndKilled++;
          }
        }
        nlog(
          `[graze] L${L} 距離d=${d}(射程${r.toFixed(0)}): 12 個接近方向中 落地 ${ok} 攔截 ${intercepted} 落地且 SAM 完全沒開火 ${silent} 其中 SAM 被炸毀 ${silentAndKilled}`,
        );
      }
    }
  }, 7_200_000);

  test("needed: baseline hold threshold, nukes to get there, and the troop alternative", async () => {
    nlog(`==== needed ${new Date().toISOString()} ====`);
    nlog(
      "[假設] 30 格堡壘 + 1 億兵能守住(失地<=10%)的進攻量遠小於 1 億;要把 10 億壓到那個量需要的氫彈數很多,而把防守兵力補到 10 億要十億級金幣",
    );
    // (i) what attack size does 1e8 + lat30 hold? (defender regenerates)
    for (const commit of [1e7, 2e7, 3e7, 5e7, 7e7, 1e8, 2e8, 5e8, 1e9]) {
      const r = await runNukeScenario({
        label: `hold-A${fmtN(commit)}`,
        nationTroops: commit * 1.2,
        // cap must not clip the attack: 6000 city levels = ~1.5e9
        cityLevels: 6000,
        difficulty: Difficulty.Hard,
        defTroops: 1e8,
        defCityLevels: DEF_LEVELS,
        fort: "lat30",
        forcedAttack: commit,
        sams: [],
        nukes: [],
        frozenNationRegen: true,
        maxTicks: 3000,
        sampleEvery: 100,
      });
      nlog(
        `[hold] 進攻 ${fmtN(commit)} vs 1e8+lat30: 失地 ${(r.lostFrac * 100).toFixed(1)}% (${r.endReason})`,
      );
    }
    // (ii) how many hydrogens (free corridors only) to cut 1e9 down
    const { m, sets } = await layouts();
    const silosPts = [
      { x: 625, y: 60 },
      { x: 625, y: 250 },
      { x: 625, y: 440 },
      { x: 710, y: 250 },
      { x: 800, y: 60 },
      { x: 800, y: 250 },
      { x: 800, y: 440 },
    ];
    for (const cfgName of ["none", "sparse", "real12", "real24"] as const) {
      const w = await siegeWorld(m, { attackerType: PlayerType.Nation });
      const units = placeSams(w, sets[cfgName], false);
      for (let i = 0; i < 70; i++) w.game.executeNextTick();
      const cells = reachMap(w, units, silosPts, 24, H.inner, H.outer, 10)
        .filter((c) => c.free)
        .sort((a, b) => a.factor - b.factor);
      const picked: typeof cells = [];
      for (const c of cells) {
        if (picked.every((p) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 > 130 ** 2))
          picked.push(c);
      }
      nlog(
        `[needed] ${cfgName}: 可進入的氫彈目標 ${cells.length} 個,互相>=130格的有 ${picked.length} 個`,
      );
      for (const n of [1, 2, 3, 4, 6, 8, 10]) {
        if (n > picked.length) break;
        const plan: NukePlanItem[] = picked.slice(0, n).map((c, i) => ({
          tick: 5 + i,
          type: H.type,
          tx: c.x,
          ty: c.y,
          silo: silosPts[c.silo],
        }));
        const r = await runNukeScenario({
          label: `need-${cfgName}-H${n}`,
          nationTroops: 1.2e9,
          cityLevels: 6000,
          difficulty: Difficulty.Hard,
          defTroops: 1e8,
          defCityLevels: DEF_LEVELS,
          fort: "lat30",
          forcedAttack: 1e9,
          sams: sets[cfgName],
          nukes: plan,
          frozenNationRegen: true,
          maxTicks: 3000,
          sampleEvery: 50,
        });
        nlog(
          `[needed] ${cfgName} 氫彈×${n}(只走空走廊): 落地 ${r.landed}/攔截 ${r.intercepted} 我方失地 ${(r.lostFrac * 100).toFixed(1)}% 進攻峰值 ${fmtN(r.attackPeak)} 末 ${fmtN(r.attackEnd)} nation格 ${r.nationTilesStart}→${r.nationTilesEnd} 成本 ${fmtN(r.cost.gold)} 金幣(氫彈 ${fmtN(n * PRICE.hydrogen)} + 飛彈井 ${n} 層 ${fmtN(n * PRICE.silo)})`,
        );
      }
    }
    // (iii) the troop alternative: raise the cap with cities, full troops, lat30 vs 1e9
    for (const D of [1e8, 2e8, 4e8, 6e8, 8e8, 1e9, 1.5e9, 2e9, 3e9]) {
      const levels = Math.max(0, Math.round((D * 1.02 - 2.1e6) / 250_000));
      const r = await runNukeScenario({
        label: `troops-D${fmtN(D)}`,
        nationTroops: 1.2e9,
        cityLevels: 6000,
        difficulty: Difficulty.Hard,
        defTroops: D,
        defCityLevels: levels,
        fort: "lat30",
        forcedAttack: 1e9,
        sams: [],
        nukes: [],
        frozenNationRegen: true,
        maxTicks: 3000,
        sampleEvery: 100,
      });
      nlog(
        `[needed] 補兵 防守 ${fmtN(D)}(城市等級 ${levels}, 約 ${fmtN(levels * 1_000_000)} 金幣) vs 1e9 進攻 + lat30: 失地 ${(r.lostFrac * 100).toFixed(1)}% (${r.endReason})`,
      );
    }
  }, 7_200_000);
});
