// Real-game fortress drive (headless Chromium + the dev server on :9000).
// Run from the repo root under Node 24, dev server up:
//   node tests/fortress-real/real.mjs minimal
//   node tests/fortress-real/real.mjs lattice 42     (spacing in tiles)
// Every step is appended to .fortress-siege-data/real/real.log with the seconds
// since start, and screenshots go to .fortress-siege-data/real/shots/. Nothing
// here touches the engine; it only presses keys and clicks like a player.
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { gotoHome } from "../../.claude/skills/run-openfront/driver.mjs";
import {
  clickWorld,
  gameState,
  panTo,
  setAttackRatio,
  spawn,
  waitForGameReady,
  waitForSpawnPhaseEnd,
  waitForTick,
} from "../../.claude/skills/run-openfront/game.mjs";

const OUT = path.resolve(".fortress-siege-data/real");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const T0 = Date.now();
let shotNo = 0;

export function log(msg) {
  const line = `[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s] ${msg}`;
  fs.appendFileSync(path.join(OUT, "real.log"), `${line}\n`);
  console.log(line);
}

export async function shot(page, name) {
  const file = path.join(
    SHOTS,
    `${String(++shotNo).padStart(2, "0")}-${name}.png`,
  );
  await page.screenshot({ path: file });
  log(`screenshot ${path.relative(process.cwd(), file)}`);
  return file;
}

// ------------------------------------------------------------- game reads

export async function myState(page) {
  return await page.evaluate(() => {
    const g = document.querySelector("build-menu").game;
    const me = g.myPlayer();
    return {
      ticks: g.ticks(),
      troops: me.troops(),
      gold: String(me.gold()),
      tiles: me.numTilesOwned(),
      posts: me.units("Defense Post").length,
      outgoing: me.outgoingAttacks().length,
    };
  });
}

/** The engine's own answer to "can I build a Defense Post here, and at what price". */
export async function canBuildPost(page, x, y) {
  return await page.evaluate(
    async ([px, py]) => {
      const g = document.querySelector("build-menu").game;
      const me = g.myPlayer();
      const acts = await me.actions(g.ref(px, py), ["Defense Post"]);
      const b = acts.buildableUnits.find((u) => u.type === "Defense Post");
      if (b === undefined) return { known: false };
      // canBuild is the tile the engine would really build on: it moves a click
      // that is within 15 of another structure to the nearest legal tile.
      const spawn =
        b.canBuild === false
          ? null
          : { x: g.x(b.canBuild), y: g.y(b.canBuild) };
      return {
        known: true,
        canBuild: b.canBuild !== false,
        cost: String(b.cost),
        spawn,
        moved: spawn === null ? null : Math.hypot(spawn.x - px, spawn.y - py),
      };
    },
    [x, y],
  );
}

// ----------------------------------------------------------------- actions

/** One real placement: hotkey 4, then a left click on the tile. */
export async function placePost(page, x, y) {
  const t = Date.now();
  const q = await canBuildPost(page, x, y);
  if (!q.known || !q.canBuild) {
    return { ok: false, reason: "引擎回報不可蓋", q, ms: Date.now() - t };
  }
  const before = (await myState(page)).posts;
  await page.keyboard.press("Digit4");
  const ghost = await page.evaluate(
    () =>
      document.querySelector("control-panel")?.uiState?.ghostStructure ?? null,
  );
  await clickWorld(page, x, y);
  let after = before;
  for (let i = 0; i < 20 && after === before; i++) {
    await page.waitForTimeout(250);
    after = (await myState(page)).posts;
  }
  return {
    ok: after > before,
    ghost,
    q,
    ms: Date.now() - t,
    reason: after > before ? "" : "點擊後沒有新堡壘",
  };
}

// The client now refuses software WebGL (SwiftShader/llvmpipe; initGL.ts), and
// driver.mjs hard-codes --disable-gpu, so headless Chromium must be told to use
// the real GPU through ANGLE/D3D11 (measured: RTX 4060 instead of SwiftShader).
async function launchGpu() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"],
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) =>
    log(`PAGEERROR ${e.message.split("\n")[0].slice(0, 200)}`),
  );
  page.on("crash", () => log("PAGE CRASHED"));
  return { browser, page };
}

export async function newSolo(opts) {
  const { browser, page } = await launchGpu();
  page.on("console", (m) => {
    if (/error/i.test(m.type()))
      log(`PAGE ${m.type()}: ${m.text().slice(0, 160)}`);
  });
  log("開啟首頁");
  await gotoHome(page);
  // The skill's openSoloModal only matches the English label "Solo"; this
  // machine's browser locale renders it as 單人模式.
  await page
    .locator("button:visible", { hasText: /solo|單人/i })
    .first()
    .click();
  await page.waitForTimeout(1500);
  await page.evaluate((o) => {
    const modal = document.querySelector("single-player-modal");
    if (o.nations !== undefined) modal.nations = o.nations;
    if (o.goldMultiplier !== undefined) {
      modal.goldMultiplier = true;
      modal.goldMultiplierValue = o.goldMultiplier;
    }
    if (o.startingGold !== undefined) {
      modal.startingGold = true;
      modal.startingGoldValue = o.startingGold;
    }
  }, opts);
  log(`開局設定 ${JSON.stringify(opts)}`);
  // The skill's startSoloGame clicks o-button[translationKey="single_modal.start"],
  // which is now "game_settings.start"; set the same properties, click the new one.
  await page.evaluate((o) => {
    const modal = document.querySelector("single-player-modal");
    for (const k of [
      "bots",
      "instantBuild",
      "infiniteGold",
      "infiniteTroops",
    ]) {
      if (o[k] !== undefined) modal[k] = o[k];
    }
    if (o.map !== undefined) modal.selectedMap = o.map;
    if (o.difficulty !== undefined) modal.selectedDifficulty = o.difficulty;
  }, opts);
  await page.waitForTimeout(300);
  await page
    .locator('o-button[translationKey="game_settings.start"] button:visible')
    .first()
    .click();
  await waitForGameReady(page);
  log(`遊戲就緒 ${JSON.stringify(await gameState(page))}`);
  return { browser, page };
}

// ------------------------------------------------- territory and lattice

/** Land tile farthest from water (coarse chamfer distance), as a spawn click. */
export async function pickInlandSpawn(page) {
  return await page.evaluate(() => {
    const g = document.querySelector("build-menu").game;
    const S = 4;
    const gw = Math.floor(g.width() / S);
    const gh = Math.floor(g.height() / S);
    const d = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const ref = g.ref(x * S, y * S);
        d[y * gw + x] = g.isLand(ref) && !g.hasOwner(ref) ? 1e6 : 0;
      }
    }
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) v = Math.min(v, d[i - gw] + 1);
        d[i] = v;
      }
    }
    for (let y = gh - 1; y >= 0; y--) {
      for (let x = gw - 1; x >= 0; x--) {
        const i = y * gw + x;
        let v = d[i];
        if (x < gw - 1) v = Math.min(v, d[i + 1] + 1);
        if (y < gh - 1) v = Math.min(v, d[i + gw] + 1);
        d[i] = v;
      }
    }
    let best = 0;
    let bi = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] < 1e6 && d[i] > best) {
        best = d[i];
        bi = i;
      }
    }
    return { x: (bi % gw) * S, y: Math.floor(bi / gw) * S, inland: best * S };
  });
}

/** Unowned land touching my territory, far from my centroid: the expansion click. */
export async function findFrontier(page) {
  return await page.evaluate(() => {
    const g = document.querySelector("build-menu").game;
    const me = g.myPlayer();
    const mine = (x, y) => g.isValidCoord(x, y) && g.owner(g.ref(x, y)) === me;
    const loc = me.nameLocation();
    const cx = Math.round(loc?.x ?? 0);
    const cy = Math.round(loc?.y ?? 0);
    const R = 450;
    let best = null;
    let bestD = -1;
    for (
      let y = Math.max(0, cy - R);
      y < Math.min(g.height(), cy + R);
      y += 3
    ) {
      for (
        let x = Math.max(0, cx - R);
        x < Math.min(g.width(), cx + R);
        x += 3
      ) {
        const ref = g.ref(x, y);
        if (!g.isLand(ref) || g.hasOwner(ref)) continue;
        if (
          !(
            mine(x - 3, y) ||
            mine(x + 3, y) ||
            mine(x, y - 3) ||
            mine(x, y + 3)
          )
        )
          continue;
        const dd = (x - cx) ** 2 + (y - cy) ** 2;
        if (dd > bestD) {
          bestD = dd;
          best = { x, y };
        }
      }
    }
    return best;
  });
}

/** Click-expand until `target` tiles; logs every round. Returns the final state. */
export async function growTo(page, target, budgetS) {
  const start = Date.now();
  let lastTiles = -1;
  let stalls = 0;
  while ((Date.now() - start) / 1000 < budgetS) {
    const s = await myState(page);
    log(
      `擴張 tiles=${s.tiles} troops=${s.troops} tick=${s.ticks} 進行中攻擊=${s.outgoing}`,
    );
    if (s.tiles >= target) return await stopExpansion(page);
    stalls = s.tiles === lastTiles ? stalls + 1 : 0;
    lastTiles = s.tiles;
    if (stalls >= 6) {
      log("擴張停滯 6 輪,停止(可能被水/海岸擋住)");
      return s;
    }
    if (s.outgoing === 0) {
      const f = await findFrontier(page);
      if (f === null) {
        log("找不到可擴張的邊界");
        return s;
      }
      await clickWorld(page, f.x, f.y);
    }
    await waitForTick(page, s.ticks + (s.tiles > target * 0.5 ? 8 : 40));
  }
  return await stopExpansion(page);
}

/** Press the attack list's cross like a player, then wait for the border to settle. */
async function stopExpansion(page) {
  let s = await myState(page);
  if (s.outgoing > 0) {
    await page.getByText("❌").first().click();
    log("按下進攻列表的 ❌ 取消擴張");
  }
  for (let i = 0; i < 40; i++) {
    await waitForTick(page, s.ticks + 10);
    const n = await myState(page);
    if (n.outgoing === 0 && n.tiles === s.tiles) {
      log(`領土穩定 tiles=${n.tiles}`);
      return n;
    }
    s = n;
  }
  log(`領土仍在變動 tiles=${s.tiles}`);
  return s;
}

/** Owned land tiles of mine as [x,y] pairs plus the bounding box. */
async function ownedTiles(page) {
  return await page.evaluate(() => {
    const g = document.querySelector("build-menu").game;
    const me = g.myPlayer();
    const loc = me.nameLocation();
    const cx = Math.round(loc?.x ?? 0);
    const cy = Math.round(loc?.y ?? 0);
    const R = 500;
    const xs = [];
    const ys = [];
    for (let y = Math.max(0, cy - R); y < Math.min(g.height(), cy + R); y++) {
      for (let x = Math.max(0, cx - R); x < Math.min(g.width(), cx + R); x++) {
        if (g.owner(g.ref(x, y)) === me) {
          xs.push(x);
          ys.push(y);
        }
      }
    }
    return { xs, ys };
  });
}

/** One post per `spacing`-sized cell that holds my land, at the tile nearest the cell centre. */
export function latticePlan(owned, spacing) {
  const cells = new Map();
  for (let i = 0; i < owned.xs.length; i++) {
    const x = owned.xs[i];
    const y = owned.ys[i];
    const key = `${Math.floor(x / spacing)},${Math.floor(y / spacing)}`;
    const c = cells.get(key) ?? {
      cx: (Math.floor(x / spacing) + 0.5) * spacing,
      cy: (Math.floor(y / spacing) + 0.5) * spacing,
      best: null,
      bd: Infinity,
      tiles: [],
    };
    const d = (x - c.cx) ** 2 + (y - c.cy) ** 2;
    if (d < c.bd) {
      c.bd = d;
      c.best = { x, y };
    }
    if (c.tiles.length < 400 && d < (spacing / 2) ** 2) c.tiles.push({ x, y });
    cells.set(key, c);
  }
  return [...cells.values()].filter((c) => c.best !== null);
}

/** Share of my tiles within `range` of a finished/under-construction post. */
export async function coverageOf(page, range = 30) {
  return await page.evaluate((r) => {
    const g = document.querySelector("build-menu").game;
    const me = g.myPlayer();
    const posts = me
      .units("Defense Post")
      .map((u) => ({
        x: g.x(u.tile()),
        y: g.y(u.tile()),
        done: !u.isUnderConstruction?.(),
      }));
    const loc = me.nameLocation();
    const cx = Math.round(loc?.x ?? 0);
    const cy = Math.round(loc?.y ?? 0);
    let total = 0;
    let covered = 0;
    let coveredDone = 0;
    for (
      let y = Math.max(0, cy - 500);
      y < Math.min(g.height(), cy + 500);
      y++
    ) {
      for (
        let x = Math.max(0, cx - 500);
        x < Math.min(g.width(), cx + 500);
        x++
      ) {
        if (g.owner(g.ref(x, y)) !== me) continue;
        total++;
        let any = false;
        let anyDone = false;
        for (const p of posts) {
          if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r * r) {
            any = true;
            if (p.done) {
              anyDone = true;
              break;
            }
          }
        }
        if (any) covered++;
        if (anyDone) coveredDone++;
      }
    }
    return {
      total,
      posts: posts.length,
      done: posts.filter((p) => p.done).length,
      covered: covered / Math.max(1, total),
      coveredDone: coveredDone / Math.max(1, total),
    };
  }, range);
}

async function frameTerritory(page, scale) {
  await page.evaluate((s) => {
    const t = document.querySelector("build-menu").transformHandler;
    t.clearTarget();
    t.scale = s;
  }, scale);
  const loc = await page.evaluate(() => {
    const l = document
      .querySelector("build-menu")
      .game.myPlayer()
      .nameLocation();
    return { x: Math.round(l.x), y: Math.round(l.y) };
  });
  await panTo(page, loc.x, loc.y);
}

// ------------------------------------------------------------------- flows

async function lattice(spacing, targetTiles, growBudgetS) {
  const { browser, page } = await newSolo({
    bots: 0,
    nations: 0,
    instantBuild: false,
    infiniteGold: false,
    infiniteTroops: true,
    startingGold: 500, // million; cost still applies, it only removes the wait
    difficulty: "Easy",
  });
  try {
    const sp = await pickInlandSpawn(page);
    log(`選內陸出生點 (${sp.x},${sp.y}) 離水約 ${sp.inland} 格`);
    await spawn(page, sp);
    await waitForSpawnPhaseEnd(page);
    await setAttackRatio(page, 1);
    log(`出生完成 ${JSON.stringify(await myState(page))}`);

    const g0 = Date.now();
    const grown = await growTo(page, targetTiles, growBudgetS);
    log(
      `擴張結束 tiles=${grown.tiles} 花費 ${((Date.now() - g0) / 1000).toFixed(0)}s 遊戲 ${grown.ticks} ticks`,
    );
    await frameTerritory(page, 1.4);
    await shot(page, `territory-${grown.tiles}`);

    const owned = await ownedTiles(page);
    const plan = latticePlan(owned, spacing);
    log(
      `間距 ${spacing}: 領土 ${owned.xs.length} 格 → 需 ${plan.length} 座(每個含己方土地的 ${spacing}x${spacing} 格子一座)`,
    );

    const t0 = Date.now();
    let inputs = 0;
    let ok = 0;
    const fails = [];
    const per = [];
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i];
      const tries = [c.best, ...c.tiles.slice(0, 6)];
      let placed = false;
      for (const p of tries) {
        const r = await placePost(page, p.x, p.y);
        inputs += 3; // hotkey, pointer move, click
        if (r.ok) {
          placed = true;
          per.push(r.ms);
          if (i < 8 || (i + 1) % 20 === 0)
            log(
              `  第 ${i + 1} 座 (${p.x},${p.y}) 價格 ${r.q.cost} 耗時 ${r.ms}ms`,
            );
          break;
        }
        fails.push(`(${p.x},${p.y}) ${r.reason}`);
      }
      if (placed) ok++;
      if ((i + 1) % 10 === 0 || i === plan.length - 1) {
        const s = await myState(page);
        log(
          `放置進度 ${i + 1}/${plan.length} 成功 ${ok} 金幣 ${s.gold} 用時 ${((Date.now() - t0) / 1000).toFixed(0)}s`,
        );
      }
    }
    const cost = await canBuildPost(page, plan[0].best.x, plan[0].best.y);
    log(
      `放置完成 成功 ${ok}/${plan.length} 失敗嘗試 ${fails.length} 次 輸入 ${inputs} 次 總用時 ${((Date.now() - t0) / 1000).toFixed(0)}s 平均每座 ${(per.reduce((a, b) => a + b, 0) / Math.max(1, per.length)).toFixed(0)}ms 下一座價格 ${cost.cost}`,
    );
    for (const f of fails.slice(0, 12)) log(`  失敗: ${f}`);
    // The 15-tile structure spacing rule, asked of the engine on land I own.
    const base = plan[Math.floor(plan.length / 2)].best;
    const rule = [];
    for (const d of [5, 10, 14, 15, 16, 20]) {
      for (const [dx, dy] of [
        [d, 0],
        [-d, 0],
        [0, d],
        [0, -d],
      ]) {
        const x = base.x + dx;
        const y = base.y + dy;
        const owned = await page.evaluate(
          ([px, py]) => {
            const g = document.querySelector("build-menu").game;
            return (
              g.isValidCoord(px, py) &&
              g.owner(g.ref(px, py)) === g.myPlayer() &&
              g.isLand(g.ref(px, py))
            );
          },
          [x, y],
        );
        if (!owned) continue;
        const q = await canBuildPost(page, x, y);
        rule.push(`${d}格→${q.canBuild ? "可蓋" : "不可蓋"}`);
        break;
      }
    }
    log(`15格規則(離某座堡壘 (${base.x},${base.y}) 的距離): ${rule.join(" ")}`);
    const s = await myState(page);
    await waitForTick(page, s.ticks + 80);
    const cov = await coverageOf(page);
    log(
      `涵蓋率(實測) ${JSON.stringify(cov)} 最終 ${JSON.stringify(await myState(page))}`,
    );
    await shot(page, `lattice-${spacing}-done`);
  } finally {
    await browser.close();
  }
}

async function minimal() {
  const { browser, page } = await newSolo({
    bots: 0,
    nations: 0,
    instantBuild: false,
    infiniteGold: true,
    infiniteTroops: true,
    difficulty: "Easy",
  });
  try {
    await shot(page, "spawn-phase");
    const tile = await spawn(page);
    log(`出生點 (${tile.x},${tile.y})`);
    await waitForSpawnPhaseEnd(page);
    log(`出生完成 ${JSON.stringify(await myState(page))}`);
    await setAttackRatio(page, 1);
    await shot(page, "spawned");

    const probe = async (dx, dy) => {
      const x = tile.x + dx;
      const y = tile.y + dy;
      const q = await canBuildPost(page, x, y);
      log(`  可蓋? (${x},${y}) 偏移(${dx},${dy}) → ${JSON.stringify(q)}`);
    };
    log(`起始 ${JSON.stringify(await myState(page))}`);
    const first = await placePost(page, tile.x, tile.y);
    log(`第 1 座 (${tile.x},${tile.y}) → ${JSON.stringify(first)}`);
    await waitForTick(page, (await myState(page)).ticks + 20);
    await shot(page, "post-1");
    await probe(8, 0);
    await probe(14, 0);
    await probe(16, 0);
    await probe(0, 16);
    log(`最終 ${JSON.stringify(await myState(page))}`);
  } finally {
    await browser.close();
  }
}

/** Top players by troops: tiles, troops, city levels, the engine's own cap, biggest attack. */
async function topPlayers(page, n = 4) {
  return await page.evaluate((k) => {
    const g = document.querySelector("build-menu").game;
    const cfg = g.config();
    return g
      .players()
      .filter((p) => p.isAlive())
      .map((p) => ({
        name: p.name(),
        type: p.type(),
        tiles: p.numTilesOwned(),
        troops: p.troops(),
        levels: p.totalUnitLevels("City"),
        cap: cfg.maxTroops(p),
        attack: Math.max(0, ...p.outgoingAttacks().map((a) => a.troops)),
        gold: String(p.gold()),
      }))
      .sort((a, b) => b.troops - a.troops)
      .slice(0, k);
  }, n);
}

/** Real game: watch how big the computer nations get with 10x gold and a 1B start. */
async function nations(durationS, difficulty) {
  const { browser, page } = await newSolo({
    bots: 0,
    nations: 60,
    instantBuild: false,
    infiniteGold: false,
    infiniteTroops: false,
    goldMultiplier: 10,
    startingGold: 1000, // million: the UI's maximum (1e9)
    difficulty,
  });
  try {
    const sp = await pickInlandSpawn(page);
    await spawn(page, sp);
    await waitForSpawnPhaseEnd(page);
    log(`出生完成 ${JSON.stringify(await myState(page))}`);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Period");
    log("按 3 次 '.' 加速到最快");
    await shot(page, "nations-start");
    const t0 = Date.now();
    let lastTick = (await myState(page)).ticks;
    let lastT = Date.now();
    let next = 10;
    while ((Date.now() - t0) / 1000 < durationS) {
      await page.waitForTimeout(1000);
      const el = (Date.now() - t0) / 1000;
      if (el < next) continue;
      next += 10;
      const s = await myState(page);
      const tps = (
        (s.ticks - lastTick) /
        ((Date.now() - lastT) / 1000)
      ).toFixed(0);
      lastTick = s.ticks;
      lastT = Date.now();
      const top = await topPlayers(page);
      log(
        `取樣 t=${el.toFixed(0)}s tick=${s.ticks} (${tps} tick/s) 遊戲時間=${(s.ticks / 600).toFixed(1)}分`,
      );
      for (const p of top) {
        log(
          `   ${p.type.padEnd(6)} ${p.name.slice(0, 14).padEnd(14)} 格=${p.tiles} 兵=${p.troops} (${(p.troops / 1e6).toFixed(1)}M, 畫面顯示 ${(p.troops / 1e7).toFixed(1)}M) 城市等級=${p.levels} 上限=${p.cap.toExponential(2)} 進攻中最大=${p.attack}`,
        );
      }
    }
    await shot(page, "nations-end");
  } finally {
    await browser.close();
  }
}

/** How the engine treats a fortress click near an existing structure, in a real game. */
async function rule15() {
  const { browser, page } = await newSolo({
    bots: 0,
    nations: 0,
    instantBuild: true,
    infiniteGold: true,
    infiniteTroops: true,
    difficulty: "Easy",
  });
  try {
    const sp = await pickInlandSpawn(page);
    await spawn(page, sp);
    await waitForSpawnPhaseEnd(page);
    await setAttackRatio(page, 1);
    const s = await growTo(page, 6000, 60);
    log(`領土 ${s.tiles} 格`);
    const c = { x: sp.x, y: sp.y };
    const first = await placePost(page, c.x, c.y);
    log(`第 1 座 (${c.x},${c.y}) → ok=${first.ok}`);
    await waitForTick(page, (await myState(page)).ticks + 20);
    for (const d of [0, 3, 8, 12, 14, 15, 16, 20, 30]) {
      const q = await canBuildPost(page, c.x + d, c.y);
      log(
        `  點離堡壘 ${String(d).padStart(2)} 格 → ${q.canBuild ? `可蓋,實際蓋在 (${q.spawn.x},${q.spawn.y}),被挪動 ${q.moved.toFixed(1)} 格` : "不可蓋"}`,
      );
    }
    // And actually click at 5 tiles away: where does the post land?
    const before = (await myState(page)).posts;
    await placePost(page, c.x + 5, c.y);
    await waitForTick(page, (await myState(page)).ticks + 20);
    const where = await page.evaluate(() => {
      const g = document.querySelector("build-menu").game;
      return g
        .myPlayer()
        .units("Defense Post")
        .map((u) => [g.x(u.tile()), g.y(u.tile())]);
    });
    log(
      `點 5 格外後堡壘數 ${before} → ${where.length},位置 ${JSON.stringify(where)}`,
    );
    await shot(page, "rule15");
  } finally {
    await browser.close();
  }
}

const cmd = process.argv[2] ?? "minimal";
if (cmd === "rule15") await rule15();
if (cmd === "minimal") await minimal();
if (cmd === "nations") {
  await nations(Number(process.argv[3] ?? 300), process.argv[4] ?? "Hard");
}
if (cmd === "lattice") {
  await lattice(
    Number(process.argv[3] ?? 42),
    Number(process.argv[4] ?? 100000),
    Number(process.argv[5] ?? 600),
  );
}
