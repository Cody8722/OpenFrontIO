// Counts every action a nation sends, by type, without changing the game.
// An "action" is an execution the nation adds to the game during its own tick
// (attacks, boats, emojis, buildings, nukes, MIRVs, alliance requests...).
// Both wrappers call the original and return what it returns.
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { GameImpl } from "@openfront/engine/game/GameImpl";

export const actionProbe = {
  installed: false,
  current: null as string | null,
  counts: new Map<string, Map<string, number>>(),
};

export function resetActionCounts(): void {
  actionProbe.counts = new Map();
  actionProbe.current = null;
}

/** nation id -> action type -> count, as plain data. */
export function actionCounts(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [id, byType] of actionProbe.counts) {
    out[id] = Object.fromEntries([...byType].sort());
  }
  return out;
}

function typeOf(exec: object): string {
  const name = exec.constructor.name;
  // a building is counted by what it builds
  const built = (exec as { constructionType?: string }).constructionType;
  return built === undefined ? name : `${name}:${built}`;
}

export function installActionProbe(): void {
  if (actionProbe.installed) return;
  actionProbe.installed = true;

  const nation = NationExecution.prototype as unknown as {
    tick(this: unknown, ticks: number): void;
  };
  const tick = nation.tick;
  nation.tick = function (this: unknown, ticks: number): void {
    const previous = actionProbe.current;
    actionProbe.current = (
      this as { nation: { playerInfo: { id: string } } }
    ).nation.playerInfo.id;
    try {
      tick.call(this, ticks);
    } finally {
      actionProbe.current = previous;
    }
  };

  const game = GameImpl.prototype as unknown as {
    addExecution(this: unknown, ...execs: object[]): void;
  };
  const add = game.addExecution;
  game.addExecution = function (this: unknown, ...execs: object[]): void {
    const id = actionProbe.current;
    if (id !== null) {
      let byType = actionProbe.counts.get(id);
      if (byType === undefined) {
        byType = new Map();
        actionProbe.counts.set(id, byType);
      }
      for (const e of execs) {
        const t = typeOf(e);
        byType.set(t, (byType.get(t) ?? 0) + 1);
      }
    }
    add.apply(this, execs);
  };
}
