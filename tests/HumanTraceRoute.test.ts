// Behaviour pinned: the dev-only Human Trace endpoints store a trace under a
// directory, the record stays valid JSON after every append, bad ids and bad
// payloads are refused, and the routes are only mounted by Worker.ts on a dev
// server.
import express from "express";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendRecord,
  appendTrace,
  isTraceId,
  registerHumanTraceRoutes,
} from "../src/server/HumanTraceRoute";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "human-trace-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const read = (f: string) => fs.readFile(path.join(dir, f), "utf8");

describe("appendTrace", () => {
  it("appends JSON lines and skips a broken one", async () => {
    expect(
      await appendTrace(dir, "trace001", [
        '{"k":"a"}',
        "not json",
        '{"k":"b"}',
      ]),
    ).toBe(2);
    expect(await appendTrace(dir, "trace001", ['{"k":"c"}'])).toBe(1);
    const lines = (await read("trace001.jsonl")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).k)).toEqual(["a", "b", "c"]);
  });
  it("refuses a bad id or payload", async () => {
    expect(await appendTrace(dir, "../evil", ['{"k":1}'])).toBe(-1);
    expect(await appendTrace(dir, "trace001", "x")).toBe(-1);
    expect(isTraceId("trace001")).toBe(true);
    expect(isTraceId("a/b")).toBe(false);
  });
});

describe("appendRecord", () => {
  const turn = (n: number) => ({ turnNumber: n, intents: [], arrivalMs: n });

  it("keeps the file valid JSON after every append", async () => {
    expect(
      await appendRecord(dir, "trace001", { gameID: "trace001" }, []),
    ).toBe(0);
    let doc = JSON.parse(await read("trace001.record.json"));
    expect(doc.turns).toEqual([]);

    await appendRecord(dir, "trace001", { gameID: "trace001" }, [turn(0)]);
    await appendRecord(dir, "trace001", null, [turn(1), turn(2)]);
    await appendRecord(dir, "trace001", null, []);
    await appendRecord(dir, "trace001", null, [turn(3)]);
    doc = JSON.parse(await read("trace001.record.json"));
    expect(doc.header).toEqual({ gameID: "trace001" });
    expect(doc.turns.map((t: { turnNumber: number }) => t.turnNumber)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("creates the file from a header, refuses without one", async () => {
    expect(await appendRecord(dir, "trace002", null, [turn(0)])).toBe(-2);
    expect(await appendRecord(dir, "trace002", { a: 1 }, [turn(0)])).toBe(1);
    expect(JSON.parse(await read("trace002.record.json")).turns).toHaveLength(
      1,
    );
  });

  it("drops entries without an integer turn number", async () => {
    await appendRecord(dir, "trace003", { a: 1 }, [
      turn(0),
      { turnNumber: "x" },
      "junk",
      null,
    ]);
    expect(JSON.parse(await read("trace003.record.json")).turns).toHaveLength(
      1,
    );
  });

  it("serialises concurrent appends", async () => {
    await appendRecord(dir, "trace004", { a: 1 }, []);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        appendRecord(dir, "trace004", null, [turn(i)]),
      ),
    );
    const doc = JSON.parse(await read("trace004.record.json"));
    expect(doc.turns).toHaveLength(30);
  });
});

describe("HTTP routes", () => {
  async function withServer(fn: (base: string) => Promise<void>) {
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    registerHumanTraceRoutes(app, dir);
    const server = app.listen(0);
    try {
      await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.close();
    }
  }
  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores and returns both files", async () => {
    await withServer(async (base) => {
      let r = await post(`${base}/api/human-trace/trace001/trace`, {
        lines: ['{"k":"header"}'],
      });
      expect(r.status).toBe(200);
      r = await post(`${base}/api/human-trace/trace001/record`, {
        header: { gameID: "trace001" },
        turns: [{ turnNumber: 0, intents: [], arrivalMs: 1 }],
      });
      expect(r.status).toBe(200);
      const t = await fetch(`${base}/api/human-trace/trace001/trace`);
      expect((await t.text()).trim()).toBe('{"k":"header"}');
      const rec = await fetch(`${base}/api/human-trace/trace001/record`);
      expect(JSON.parse(await rec.text()).turns).toHaveLength(1);
    });
  });

  it("answers 400 to a bad id and 404 to a missing file", async () => {
    await withServer(async (base) => {
      expect(
        (await post(`${base}/api/human-trace/bad!id/trace`, { lines: [] }))
          .status,
      ).toBe(400);
      expect(
        (await fetch(`${base}/api/human-trace/trace009/trace`)).status,
      ).toBe(404);
    });
  });
});

describe("mounting", () => {
  it("Worker.ts mounts the routes only in the Dev environment", async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), "src/server/Worker.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /if \(ServerEnv\.env\(\) === GameEnv\.Dev\) \{\s*registerHumanTraceRoutes\(app\);/,
    );
  });
  it(".human-trace is ignored by git", async () => {
    const ignore = await fs.readFile(
      path.join(process.cwd(), ".gitignore"),
      "utf8",
    );
    expect(ignore.split("\n")).toContain(".human-trace/");
  });
});
