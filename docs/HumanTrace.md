# Human Trace (真人操作錄影)

A dev-only recording of how a person plays a **single-player** game: their
inputs, the intents those produce, the camera, and the turn stream. It is a
tool for watching and analysing play, not a replay system and not a way to
play for someone. Multiplayer is not implemented in this version.

Off by default. Nothing in the game changes: the recorder only reads (events
that already happen, values the page already holds) and every call is wrapped
so a failure never reaches the game.

## Turning it on

Page URL, dev build only, single-player only:

| parameter | records |
|---|---|
| `?humanTrace=1` | inputs, intents, camera, turns |
| `?humanTrace=moves` | the same plus the mouse path at about 20 Hz |

The query is captured at page load by `captureDevSearch` (same as
`nationTiming`), because a game start rewrites the address bar. Other params
(`nationTiming`, `nationTimingLog`) are kept in the header's `urlParams`.

## Where it hooks in (all read-only)

| place | what it does |
|---|---|
| `LocalServer.start` | `beginHumanTrace` creates the recorder (nothing unless asked for) |
| `LocalServer.onMessage` | notes each intent and whether it was sent or dropped because the game is paused |
| `LocalServer.endTurn` | notes each turn as it is handed to the client, with `performance.now` |
| `ClientGameRunner.start/stop` | attaches / detaches passive window listeners (`HumanTraceHook`) |
| `Worker.ts` | mounts `/api/human-trace/*` **only when the server runs in the Dev environment** |

Untouched: the precheck in the build UI, the input handler, `Transport`,
`ClientMsgRateLimiter`, the engine and the worker protocol.

## Files

`.human-trace/<gameID>.jsonl` (gitignored), one JSON object per line, appended
every 2 s while the game runs.

| `k` | content |
|---|---|
| `header` | gameID, commit, mode, map, difficulty, nations, bots, seed (the engine seeds from the game id), players, all URL params, screen size, devicePixelRatio, wall start time, tick base, version |
| `input` | `tMs` (performance.now since start), game `tick`, `type` (`pointerdown`, `pointerup`, `drag`, `wheel`, `key`, `move`), screen x/y, world cell, owner under the cursor, modifiers, open menu (`radial`/`build`), selected build unit (`selected`) |
| `intent` | `tMs`, `tick`, `serverTick` (the turn it goes into), `type`, full `params`, `outcome` (`sent` or `dropped_paused`), `state` (gold, troops, tiles, unit counts by type) |
| `turn` | a turn that carried intents: number, count, types (confirms the intents came back from the local server) |
| `sync` | every 50 turns: turn number and game tick |
| `event` | `tMs`, `tick`, `ev` and fields per kind (see "Event stream") |
| `camera` | scale and centre, at most 4 per second, only on change |
| `winner`, `end` | markers |

Keys typed into an input, textarea, select or editable element are never
recorded. Other keys are recorded by `code` (the game's hotkeys are ordinary
keys, so they cannot be told apart from other keys outside text fields).

`.human-trace/<gameID>.record.json` is written turn by turn, **valid JSON
after every append** (the file always ends in `]}` and an append overwrites
those two bytes):

```json
{ "version": 1,
  "header": { "gameID", "commit", "map", "difficulty", "nations", "bots", "seed",
              "players", "urlParams", "turnIntervalMs", "startedAtWall",
              "gameStartInfo": { ...the full start info the game was built from } },
  "turns": [ { "turnNumber": 0, "intents": [], "arrivalMs": 25.9 }, ... ] }
```

`arrivalMs` is `performance.now` (since the trace started) when the turn
reached the client.

If the dev endpoint cannot be reached, batches go to IndexedDB (`human-trace`
database). A button "Download input trace (dev)" appears when the game is
decided: it fetches both files from the server, or rebuilds what the browser
kept. Memory is bounded: at most 4000 buffered lines and 4000 buffered turns;
older ones are dropped and counted (`pending()`).

## How an intent outcome is known

Single-player has no server reply. The local server either puts the intent
into the next turn or, while paused, drops it. So the only outcomes are
`sent` and `dropped_paused`; a `sent` intent is later seen in the turn stream
(`turn` lines / `record.json`) and `summarize` checks that.

**A click that the build precheck refused leaves no intent.** The precheck is
not instrumented (by decision), so the analysis marks a click made with a unit
selected and no intent within 400 ms as *inferred blocked*, reason unknown.

## Size

Measured on real runs (bytes per line): `pointerdown` 219, `pointerup` 281,
`key` 103, `wheel` 92, `camera` 96, `move` 117, `intent` 180–230, `turn`
(with intents) 71. `record.json`: 53 bytes per turn.

| | per minute | per hour |
|---|---|---|
| `record.json` (600 turns/min at full speed) | about 32 KB | about 1.9 MB |
| `jsonl`, `=1`, typical play (about 1 click/s + camera) | 50–80 KB | 3–5 MB |
| `jsonl`, `=1`, a 10-per-second build burst | up to about 440 KB while it lasts | rare |
| `moves` extra, mouse moving all the time | up to about 140 KB | up to about 8 MB |

So one hour is roughly 5–7 MB (`=1`) or 13–15 MB (`moves`, worst case).
Multiplayer would multiply by the number of recorded clients (one file each);
that is an estimate, it is not implemented.

## Time base: performance.now against game ticks

One turn is one tick (`sync` lines: turn number minus game tick was 0 in every
sample). The local server hands the next turn to the client after
`turnIntervalMs` (100 ms) **and** after the client finished the previous one,
so the real pace is `max(100 ms, processing time)`.

Measured in the headless test browser with software WebGL:

| setting | ms per turn | turns per second |
|---|---|---|
| rendering throttled to 1 frame/s | 818–1049 (about 1 s) | about 1 |
| rendering almost off (1 frame per 60 s) | median 106.6, p90 113.4, p99 117, max 804 | 9.21 |

The 100 ms floor is the turn interval; the rest is processing. The first row
is the software renderer starving the page and says nothing about a machine
with a GPU: `summarize` prints `turnTiming` for any trace, so read it from a
real session.

## Event stream

`{"k":"event","ev":…}` lines for events that concern the local player, taken
from what the client already receives. One observation point was added: the
page calls the recorder once per game update, right after the view took the
update in (`ClientGameRunner`, next to `gameView.update`). It only reads the
update batch and GameView getters, so the worker, the turns and the hash chain
are not touched.

| `ev` | source | fields | status |
|---|---|---|---|
| `attacked` | the player's incoming-attack list (what the attack panel shows; the event feed has no message for an attack) | `from` (id, name, type), `troops`, `attackId` | verified in a browser |
| `transport_inbound` | `UnitIncoming` "naval invasion" alert for me | `from`, `troops`, `at`, `landing` (the boat's target tile, when the view has it) | unit test only |
| `transport_near` | a tracked boat within 25 tiles of its landing tile | `distance`, `at`, `landing` | unit test only |
| `transport_ended` | the tracked boat became inactive (landed, sunk or retreated; the view cannot tell which) | `at`, `troops` | unit test only |
| `unit_destroyed` | feed message for my warship or transport boat | `unit`, `at` (last position), `killer: null` | unit test only |
| `trade_ship_captured` | feed message, I am the former owner | `by` (captor's name), `at` | unit test only |
| `nuke_launched` | a new nuke/MIRV unit that is not mine, aimed on my land or within 40 tiles of it | `unit`, `from`, `launchedAt`, `target`, `onMyTerritory`, `distanceToMine` | unit test only |
| `alliance_request_received/sent`, `alliance_formed`, `alliance_rejected`, `alliance_broken`, `alliance_expired` | alliance updates that involve me | players involved, `iBetrayed` | received and rejected verified in a browser |

Cannot be done from what the client receives:

- **Who destroyed my unit.** The destroyer is kept inside the engine and is in
  no update; `killer` is always `null`. Only warships and transport boats have
  a feed message at all; a lost structure leaves none.
- **Where a boat will land, always.** `landing` is read from the unit's target
  tile when the view carries it; if it is absent the field is missing.
- **Boat outcome.** `transport_ended` does not say landed, sunk or retreated.
- **Nuke "near" is a coarse test** (a grid of 8-tile steps up to 40 tiles), not
  an exact distance.
- **An exact "attack on me" message.** It is derived from the incoming list, so
  attacks the panel hides (bots are filtered there, not here) are recorded here.

`summarize` adds "Events and operations": for the focus unit's batches, the
event types seen in the 60 s before each batch (counts, and mean batch size
with and without each event type), and how gold relates to batch size
(Pearson r of gold at the batch start, the gold change since the previous
batch start, and the gap since the previous batch end, against batch size). A
trace recorded before the event stream existed just reports no event lines.

## Analysis

```
npx tsx scripts/human-trace/summarize.mts .human-trace/<id>.jsonl [.human-trace/<id>.record.json] [--out dir]
```

(The script lives in `scripts/human-trace/`, not `tools/`: `tools/` is outside
the TypeScript project, so lint cannot parse a script there.)

Writes `<id>.summary.md` and `<id>.summary.json`: operations per second,
bursts (5+ of one type, each within 1 s), intent counts, gaps between
intents, build positions (8×8 grid, ring shape), inferred blocked clicks,
confirmation latency through the turn stream, turn timing, tick offset. Bad
lines are counted and skipped; a missing or truncated record is salvaged.

Per-unit sections (added later): `buildByUnit` (build_unit counts by unit);
`focusUnit` (default Warship, change with `--unit "Port"`): click batches where
neighbouring builds are at most 2 s apart, with batch count and size, rate
inside a batch, gap distribution, distinct tiles and same-tile share, spatial
extent, holdings and gold at the batch start, and distance from the batch
centre to the nearest port ordered before it (a lost port is not tracked);
the holdings curve comes from `state.units`. `blockedByUnit` splits the
inferred blocked clicks by selected unit. `<id>.chart.json` holds batches
(position, count, time), ports and the holdings curve for plotting. Build
positions come from the intent's tile index and the map width recovered from
the clicks (`mapWidthInferred`).

The ring measure is taken around the centroid of the build points (the target's
own territory centre is not in the trace). Players: one human; the "players"
section lists the header's roster.

## Replaying a `record.json` (not implemented)

`LocalServer` replays when it is built with `lobbyConfig.gameRecord` set
(`isReplay`): `start()` calls `decompressGameRecord(gameRecord).turns` and
`endTurn()` feeds those turns back one by one. `record.json` does not have the
shape of a `GameRecord`, so it needs a conversion:

| `GameRecord` field | from `record.json` |
|---|---|
| `info.gameID`, `info.config`, `info.players` | `header.gameStartInfo.gameID/config/players` (each player needs the `PlayerRecord` fields, `persistentID` and `stats`, which the trace does not have: fill defaults) |
| `info.num_turns` | last `turnNumber` + 1 |
| `info.start/end/duration/lobbyCreatedAt` | `header.startedAtWall`, plus the last `arrivalMs` |
| `info.winner` | none (leave empty) |
| `version` | `"v0.0.2"` |
| `gitCommit` | `header.commit` (`"DEV"` on a dev build) |
| `turns` | `turns` without `arrivalMs`; empty turns may stay (they are expanded anyway) |

Things that decide whether it replays identically: the client commit must
match (a replay refuses a different one), and the **same URL params**
(`header.urlParams`, notably `nationTiming`) must be given to the page, because
the nation timing switch comes from the page, not from the record. Hashes are
absent, so a replay logs "no archived hash" instead of verifying. `arrivalMs`
is not used by the local server (it paces turns by `turnIntervalMs`), so
sub-turn timing is not reproduced. This was read from the code; it has not been
run.
