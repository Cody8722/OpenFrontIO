import type { HumanTrace, TraceContext } from "./HumanTrace";

// Page-side listeners for Human Trace. All of them are passive window
// listeners in the capture phase: they never call preventDefault or
// stopPropagation, so the game's own handlers see exactly what they saw before.
// Each one only reads the event and a few plain values.

const MOVE_GAP_MS = 50; // about 20 Hz
const CAMERA_POLL_MS = 250; // the trace itself caps camera lines at 4 Hz
const DRAG_PX = 4;

/** What the hook reads of the page; every member is a plain read. */
export interface HookEnv {
  toWorld(x: number, y: number): { x: number; y: number } | undefined;
  ownerAt(
    wx: number,
    wy: number,
  ): { owner: number; isPlayer: boolean } | undefined;
  ghost(): string | null;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (el === null || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

function openMenu(): string | null {
  try {
    const radial = document.querySelector<HTMLElement>(
      ".radial-menu-container",
    );
    if (radial !== null && radial.style.display !== "none") return "radial";
    if (document.querySelector("build-menu .build-menu:not(.hidden)")) {
      return "build";
    }
  } catch {
    // No DOM answer: report nothing.
  }
  return null;
}

const mods = (e: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}) =>
  (e.shiftKey ? "S" : "") +
  (e.ctrlKey ? "C" : "") +
  (e.altKey ? "A" : "") +
  (e.metaKey ? "M" : "");

export function attachInputHook(
  trace: HumanTrace,
  env: HookEnv,
  win: Window = window,
  now: () => number = () => performance.now(),
): () => void {
  let down: { x: number; y: number; t: number; button: number } | null = null;
  let lastMove = -Infinity;

  const spatial = (x: number, y: number) => {
    const w = env.toWorld(x, y);
    const o = w === undefined ? undefined : env.ownerAt(w.x, w.y);
    return { world: w, target: o };
  };

  const onDown = (e: PointerEvent) => {
    try {
      down = { x: e.clientX, y: e.clientY, t: now(), button: e.button };
      trace.input({
        type: "pointerdown",
        button: e.button,
        x: e.clientX,
        y: e.clientY,
        ...spatial(e.clientX, e.clientY),
        mods: mods(e),
        menu: openMenu(),
        selected: env.ghost(),
      });
    } catch {
      // never disturb the page
    }
  };
  const onUp = (e: PointerEvent) => {
    try {
      const d = down;
      down = null;
      const dist =
        d === null ? 0 : Math.hypot(e.clientX - d.x, e.clientY - d.y);
      trace.input({
        type: dist > DRAG_PX ? "drag" : "pointerup",
        button: e.button,
        x: e.clientX,
        y: e.clientY,
        ...spatial(e.clientX, e.clientY),
        from: d === null ? undefined : { x: d.x, y: d.y },
        heldMs: d === null ? undefined : Math.round(now() - d.t),
        mods: mods(e),
        menu: openMenu(),
        selected: env.ghost(),
      });
    } catch {
      // never disturb the page
    }
  };
  const onMove = (e: PointerEvent) => {
    try {
      if (!trace.movesEnabled) return;
      const t = now();
      if (t - lastMove < MOVE_GAP_MS) return;
      lastMove = t;
      trace.input({
        type: "move",
        x: e.clientX,
        y: e.clientY,
        world: env.toWorld(e.clientX, e.clientY),
      });
    } catch {
      // never disturb the page
    }
  };
  const onWheel = (e: WheelEvent) => {
    try {
      trace.input({
        type: "wheel",
        deltaY: e.deltaY,
        x: e.clientX,
        y: e.clientY,
        mods: mods(e),
      });
    } catch {
      // never disturb the page
    }
  };
  const onKey = (e: KeyboardEvent) => {
    try {
      // Anything typed into a text field (chat, a name box) is not recorded.
      if (isEditable(e.target) || isEditable(win.document.activeElement))
        return;
      if (e.repeat) return;
      trace.input({
        type: "key",
        code: e.code,
        key: e.key.length === 1 ? e.key : e.key,
        mods: mods(e),
        selected: env.ghost(),
      });
    } catch {
      // never disturb the page
    }
  };

  const opt: AddEventListenerOptions = { capture: true, passive: true };
  win.addEventListener("pointerdown", onDown, opt);
  win.addEventListener("pointerup", onUp, opt);
  win.addEventListener("pointermove", onMove, opt);
  win.addEventListener("wheel", onWheel, opt);
  win.addEventListener("keydown", onKey, opt);
  const cam = setInterval(() => trace.camera(), CAMERA_POLL_MS);

  return () => {
    win.removeEventListener("pointerdown", onDown, opt);
    win.removeEventListener("pointerup", onUp, opt);
    win.removeEventListener("pointermove", onMove, opt);
    win.removeEventListener("wheel", onWheel, opt);
    win.removeEventListener("keydown", onKey, opt);
    clearInterval(cam);
  };
}

/** A context that reads the running game; failures read as "unknown". */
export function gameContext(
  game: {
    ticks(): number;
    myPlayer(): {
      gold(): bigint;
      troops(): number;
      numTilesOwned(): number;
      units(): { type(): string }[];
    } | null;
  },
  transform: { scale: number; offsetX: number; offsetY: number },
): TraceContext {
  let cachedTick = -1;
  let cached: Record<string, unknown> | undefined;
  return {
    tick: () => {
      try {
        return game.ticks();
      } catch {
        return undefined;
      }
    },
    summary: () => {
      try {
        const t = game.ticks();
        if (t === cachedTick && cached !== undefined) return cached;
        const me = game.myPlayer();
        if (me === null) return undefined;
        const units: Record<string, number> = {};
        for (const u of me.units()) {
          const k = u.type();
          units[k] = (units[k] ?? 0) + 1;
        }
        cachedTick = t;
        cached = {
          gold: Number(me.gold()),
          troops: Math.round(me.troops()),
          tiles: me.numTilesOwned(),
          units,
        };
        return cached;
      } catch {
        return undefined;
      }
    },
    camera: () => {
      try {
        return {
          scale: transform.scale,
          x: transform.offsetX,
          y: transform.offsetY,
        };
      } catch {
        return undefined;
      }
    },
  };
}
