import { isValidGameID } from "@openfront/engine-api/Schemas";
import type { Express } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";

// Dev-only endpoints that store a Human Trace on disk (see
// src/client/humanTrace). Registered by Worker.ts only when the server runs in
// the Dev environment. Output goes to <cwd>/.human-trace, which is gitignored.
//
//   POST /api/human-trace/:id/trace    {lines: string[]}        -> <id>.jsonl
//   POST /api/human-trace/:id/record   {header?, turns: []}     -> <id>.record.json
//   GET  /api/human-trace/:id/(trace|record)                    -> the file
//
// <id>.record.json is valid JSON after every append: the file always ends in
// "]}" and an append overwrites those two bytes, so a closed page loses nothing
// that was already acknowledged.

const MAX_LINES = 10_000;
const MAX_LINE_LEN = 20_000;
const MAX_TURNS = 10_000;

export const TRACE_DIR = path.join(process.cwd(), ".human-trace");

// One writer per file at a time.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  chains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

export function isTraceId(id: unknown): id is string {
  return typeof id === "string" && isValidGameID(id);
}

/** Appends the lines that parse as JSON; returns how many were written. */
export async function appendTrace(
  dir: string,
  gameID: string,
  lines: unknown,
): Promise<number> {
  if (!isTraceId(gameID) || !Array.isArray(lines)) return -1;
  const ok: string[] = [];
  for (const l of lines.slice(0, MAX_LINES)) {
    if (typeof l !== "string" || l.length > MAX_LINE_LEN) continue;
    try {
      JSON.parse(l);
      ok.push(l);
    } catch {
      // a broken line is skipped, not the whole batch
    }
  }
  if (ok.length === 0) return 0;
  const file = path.join(dir, `${gameID}.jsonl`);
  return serial(file, async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(file, ok.join("\n") + "\n");
    return ok.length;
  });
}

/** Appends turns to <id>.record.json, creating it from `header` if needed. */
export async function appendRecord(
  dir: string,
  gameID: string,
  header: unknown,
  turns: unknown,
): Promise<number> {
  if (!isTraceId(gameID) || !Array.isArray(turns)) return -1;
  const items = turns
    .slice(0, MAX_TURNS)
    .filter(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        Number.isInteger((t as { turnNumber?: unknown }).turnNumber),
    )
    .map((t) => JSON.stringify(t));
  const file = path.join(dir, `${gameID}.record.json`);
  return serial(file, async () => {
    await fs.mkdir(dir, { recursive: true });
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(file, "r+");
    } catch {
      fh = undefined;
    }
    if (fh === undefined) {
      if (typeof header !== "object" || header === null) return -2;
      const head = JSON.stringify({ version: 1, header, turns: [] });
      // head ends in `"turns":[]}`; open the array again for appending
      const body = head.slice(0, -2) + items.join(",") + "]}";
      await fs.writeFile(file, body);
      return items.length;
    }
    try {
      const { size } = await fh.stat();
      const tail = Buffer.alloc(3);
      await fh.read(tail, 0, 3, size - 3);
      if (tail.subarray(1).toString() !== "]}") return -3;
      if (items.length === 0) return 0;
      const empty = tail.subarray(0, 1).toString() === "[";
      const text = (empty ? "" : ",") + items.join(",") + "]}";
      await fh.write(text, size - 2);
      return items.length;
    } finally {
      await fh.close();
    }
  });
}

export function registerHumanTraceRoutes(app: Express, dir = TRACE_DIR): void {
  app.post("/api/human-trace/:id/trace", async (req, res) => {
    try {
      const n = await appendTrace(dir, req.params.id, req.body?.lines);
      if (n < 0) return res.status(400).json({ error: "bad request" });
      return res.json({ written: n });
    } catch {
      return res.status(500).json({ error: "write failed" });
    }
  });
  app.post("/api/human-trace/:id/record", async (req, res) => {
    try {
      const n = await appendRecord(
        dir,
        req.params.id,
        req.body?.header,
        req.body?.turns,
      );
      if (n < 0) return res.status(400).json({ error: "bad request", code: n });
      return res.json({ written: n });
    } catch {
      return res.status(500).json({ error: "write failed" });
    }
  });
  app.get("/api/human-trace/:id/:kind", async (req, res) => {
    const { id, kind } = req.params;
    if (!isTraceId(id) || (kind !== "trace" && kind !== "record")) {
      return res.status(400).json({ error: "bad request" });
    }
    const file = path.join(
      dir,
      kind === "trace" ? `${id}.jsonl` : `${id}.record.json`,
    );
    try {
      return res.type("text/plain").send(await fs.readFile(file));
    } catch {
      return res.status(404).json({ error: "not found" });
    }
  });
}
