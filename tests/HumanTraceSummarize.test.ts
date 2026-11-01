// Behaviour pinned: scripts/human-trace/summarize.mts turns a Human Trace into a
// summary (intent counts, bursts, gaps, ring shape, inferred blocked clicks,
// confirmation by the turn stream) and survives bad lines, a truncated record
// and a game cut short.
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ht-sum-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const run = (...args: string[]) =>
  execFileSync(
    process.execPath,
    ["scripts/human-trace/summarize.mts", ...args, "--out", dir],
    { cwd: process.cwd() },
  );

const summary = async (id: string) =>
  JSON.parse(await fs.readFile(path.join(dir, `${id}.summary.json`), "utf8"));

function fixture() {
  const rows: object[] = [
    { k: "header", gameID: "sum00001", players: [{ clientID: "abCD1234" }] },
  ];
  // A ring of 12 warships around (100,100), one every 100 ms.
  for (let i = 0; i < 12; i++) {
    // mid-sector angles, so rounding cannot push a point over a sector edge
    const a = ((i + 0.5) / 12) * 2 * Math.PI;
    const tMs = 1000 + i * 100;
    rows.push({
      k: "input",
      type: "pointerup",
      button: 0,
      tMs: tMs - 2,
      world: { x: 100 + 20 * Math.cos(a), y: 100 + 20 * Math.sin(a) },
      selected: "Warship",
    });
    rows.push({
      k: "intent",
      type: "build_unit",
      tMs,
      serverTick: 10 + i,
      outcome: "sent",
      params: { type: "build_unit", unit: "Warship", tile: i },
    });
  }
  // A click with a unit selected that produced nothing.
  rows.push({
    k: "input",
    type: "pointerup",
    button: 0,
    tMs: 5000,
    world: { x: 1, y: 1 },
    selected: "Warship",
  });
  rows.push({
    k: "intent",
    type: "build_unit",
    tMs: 6000,
    serverTick: 60,
    outcome: "dropped_paused",
    params: { type: "build_unit", unit: "Warship", tile: 99 },
  });
  return rows;
}

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");

describe("summarize.mts", () => {
  it("counts intents, finds the burst, the ring and the blocked click", async () => {
    const rows = fixture();
    await fs.writeFile(path.join(dir, "sum00001.jsonl"), jsonl(rows));
    run(path.join(dir, "sum00001.jsonl"));
    const s = await summary("sum00001");
    expect(s.counts.byType.build_unit).toBe(13);
    expect(s.counts.byOutcome).toEqual({ sent: 12, dropped_paused: 1 });
    expect(s.bursts).toHaveLength(1);
    expect(s.bursts[0]).toMatchObject({ type: "build_unit", count: 12 });
    expect(s.bursts[0].opsPerSecond).toBeCloseTo(10, 0);
    expect(s.buildSpatial.ring.angularCoverage12).toBe(1);
    expect(s.buildSpatial.ring.radiusCV).toBeLessThan(0.05);
    expect(s.blocked.inferredBlocked).toBe(1);
    expect(s.blocked.droppedPaused).toBe(1);
    expect(
      await fs.readFile(path.join(dir, "sum00001.summary.md"), "utf8"),
    ).toContain("# Human Trace summary");
  });

  it("survives bad lines, a missing record and a cut-short game", async () => {
    const text =
      jsonl(fixture().slice(0, 5)) +
      '\n{"k":"intent","tMs":\nnot json\n[1,2]\n';
    await fs.writeFile(path.join(dir, "cut00001.jsonl"), text);
    run(path.join(dir, "cut00001.jsonl"), path.join(dir, "nope.record.json"));
    const s = await summary("cut00001");
    expect(s.parse.badLines).toBe(3);
    expect(s.complete).toBe(false);
    expect(s.counts.intents).toBeGreaterThan(0);
  });

  it("confirms intents against the turn stream and reads a truncated record", async () => {
    const rows = fixture();
    await fs.writeFile(path.join(dir, "rec00001.jsonl"), jsonl(rows));
    const turns = rows
      .filter((r: any) => r.k === "intent" && r.outcome === "sent")
      .map((r: any) => ({
        turnNumber: r.serverTick,
        intents: [{ ...r.params, clientID: "abCD1234" }],
        arrivalMs: r.tMs + 80,
      }));
    const whole = JSON.stringify({ version: 1, header: {}, turns });
    // cut in the middle of the last turn
    await fs.writeFile(
      path.join(dir, "rec00001.record.json"),
      whole.slice(0, whole.length - 30),
    );
    run(
      path.join(dir, "rec00001.jsonl"),
      path.join(dir, "rec00001.record.json"),
    );
    const s = await summary("rec00001");
    expect(s.confirmation.confirmedInTurnStream).toBe(11);
    expect(s.confirmation.latencyMs.p50).toBe(80);
    expect(s.turnTiming.turns).toBe(11);
  });

  it("splits builds and blocked clicks by unit, batches the focus unit, writes chart data", async () => {
    const rows: object[] = [{ k: "header", gameID: "bat00001" }];
    const build = (tMs: number, unit: string, tile: number, n: number) => ({
      k: "intent",
      type: "build_unit",
      tMs,
      serverTick: 1,
      outcome: "sent",
      params: { type: "build_unit", unit, tile },
      state: { gold: 1000, units: { Warship: n } },
    });
    // a port, then batch A: 5 clicks on one tile 500 ms apart; a 5 s pause;
    // batch B: 2 clicks on two tiles
    rows.push(build(100, "Port", 0, 0));
    for (let i = 0; i < 5; i++)
      rows.push(build(1000 + i * 500, "Warship", 7, i));
    rows.push(build(10000, "Warship", 8, 5));
    rows.push(build(10800, "Warship", 9, 6));
    // a click with Port selected and no build after it
    rows.push({
      k: "input",
      type: "pointerup",
      button: 0,
      tMs: 20000,
      world: { x: 1, y: 1 },
      selected: "Port",
    });
    const f = path.join(dir, "bat00001.jsonl");
    await fs.writeFile(f, rows.map((r) => JSON.stringify(r)).join("\n"));
    run(f);
    const s = await summary("bat00001");
    expect(s.buildByUnit).toEqual({ Port: 1, Warship: 7 });
    expect(s.focusUnit.batches).toBe(2);
    expect(s.focusUnit.batchList[0]).toMatchObject({
      count: 5,
      distinctTiles: 1,
      singleTile: true,
      sameTileShare: 1,
      ratePerSecond: 2,
      holdingsAtStart: 0,
    });
    expect(s.focusUnit.batchList[1].distinctTiles).toBe(2);
    expect(s.focusUnit.batchesOfFiveOrMore).toMatchObject({
      batches: 1,
      singleTile: 1,
    });
    expect(s.focusUnit.maxHoldings).toBe(6);
    expect(s.blockedByUnit.byUnit.Port).toMatchObject({
      clicks: 1,
      blocked: 1,
    });
    const chart = JSON.parse(
      await fs.readFile(path.join(dir, "bat00001.chart.json"), "utf8"),
    );
    expect(chart.batches).toHaveLength(2);
    expect(chart.holdings.length).toBeGreaterThan(0);
  });

  it("exits with usage when given nothing", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/human-trace/summarize.mts"], {
        cwd: process.cwd(),
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
