// Gauntlet console server. Talks to the game only through files in the Mods folder.
// The contract (file formats, who writes what) is the "console contract" for the gauntlet mod.
// The game owns values and defaults; this file owns presentation and validation ranges.

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.GAUNTLET_PORT ?? 8790);
const HOST = "127.0.0.1";
const MODS_DIR =
  process.env.GAUNTLET_MODS_DIR ??
  join(homedir(), "Library", "Application Support", "OpenGOAL", "jak1", "settings", "Mods");

const SETTINGS_FILE = join(MODS_DIR, "gauntlet-settings.gc");
const STATE_FILE = join(MODS_DIR, "gauntlet-state.json");
const DROP_FILE = join(MODS_DIR, "gauntlet-drop-request.txt");
const COMMAND_FILE = join(MODS_DIR, "archipelago-command.gc");
const INDEX_FILE = join(import.meta.dirname, "index.html");

/** The game writes state every 15 frames; no change for this long means it is not running. */
const LIVE_WINDOW_MS = 2000;
const COMMAND_RETRY_MS = 100;
const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Presentation: one entry per setting, keyed by the game's setting name.
// ---------------------------------------------------------------------------

type SettingGroup =
  | "Bomb"
  | "Geyser Rock"
  | "Dummies"
  | "Stampede"
  | "Charged lurkers"
  | "Beach worms"
  | "Horde"
  | "Klaww"
  | "TNT barrels";
type SettingValue = number | boolean;
type SettingMap = Record<string, SettingValue>;

interface SettingBase {
  key: string;
  group: SettingGroup;
  label: string;
  applies: string;
  hint: string;
}
interface BooleanSpec extends SettingBase {
  kind: "boolean";
}
interface NumberSpec extends SettingBase {
  kind: "number";
  unit: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
}
type SettingSpec = BooleanSpec | NumberSpec;

function num(
  key: string,
  group: SettingGroup,
  label: string,
  unit: string,
  range: [min: number, max: number, step: number],
  applies: string,
  hint: string,
  integer = false,
): NumberSpec {
  const [min, max, step] = range;
  return { kind: "number", key, group, label, unit, min, max, step, integer, applies, hint };
}
function flag(
  key: string,
  group: SettingGroup,
  label: string,
  applies: string,
  hint: string,
): BooleanSpec {
  return { kind: "boolean", key, group, label, applies, hint };
}

const SETTINGS: readonly SettingSpec[] = [
  num(
    "bomb-countdown",
    "Bomb",
    "Countdown",
    "s",
    [1, 15, 0.5],
    "next bomb",
    "Seconds between the bomb landing and the blast.",
  ),
  num(
    "bomb-blast-radius",
    "Bomb",
    "Blast radius",
    "m",
    [5, 100, 1],
    "next blast",
    "Jak dies if he is inside this distance when the bomb goes off.",
  ),
  num(
    "bomb-pull-radius",
    "Bomb",
    "Pull radius",
    "m",
    [5, 100, 1],
    "live",
    "The bomb only pulls Jak while he is inside this distance.",
  ),
  num(
    "bomb-pull",
    "Bomb",
    "Pull in the air",
    "m/s²",
    [0, 60, 1],
    "live",
    "How hard the bomb drags Jak while he is airborne. Higher makes familiar jumps fall short.",
  ),
  num(
    "bomb-ground-pull",
    "Bomb",
    "Pull on foot or in water",
    "m/s",
    [0, 5, 0.1],
    "live",
    "A steady drag toward the bomb while Jak is on the ground or swimming.",
  ),
  num(
    "bomb-drop-height",
    "Bomb",
    "Drop height",
    "m",
    [5, 80, 1],
    "next bomb",
    "How far above Jak the bomb starts. Higher means a longer fall before the countdown.",
  ),
  num(
    "bomb-gravity",
    "Bomb",
    "Fall gravity",
    "m/s²",
    [5, 100, 1],
    "next bomb",
    "How fast the bomb falls.",
  ),
  flag(
    "bridge-enabled",
    "Geyser Rock",
    "Bridge bomb",
    "live",
    "Walking up to the Geyser bridge arms a bomb that drops on it.",
  ),
  flag(
    "vent-enabled",
    "Geyser Rock",
    "Vent bomb",
    "live",
    "Walking up to the blue eco vent before the precursor door arms a bomb that drops on it.",
  ),
  num(
    "bridge-trigger-radius",
    "Geyser Rock",
    "Trigger radius",
    "m",
    [1, 20, 0.5],
    "live",
    "How close Jak has to get to a drop spot (the bridge, the vent) to set its bomb off.",
  ),
  num(
    "bridge-rearm-range",
    "Geyser Rock",
    "Rearm range",
    "m",
    [10, 200, 5],
    "live",
    "How far Jak has to walk away before a drop spot can fire again.",
  ),
  flag(
    "dummies-enabled",
    "Dummies",
    "Dummies shoot",
    "live",
    "Off means dummies are plain dummies: no sage, no shots.",
  ),
  num(
    "dummy-volley-interval",
    "Dummies",
    "Volley interval",
    "s",
    [0.5, 10, 0.1],
    "live",
    "Time between volleys.",
  ),
  num(
    "dummy-volley-gap",
    "Dummies",
    "Gap between shots",
    "s",
    [0.1, 2, 0.05],
    "live",
    "Time between shots inside one volley.",
  ),
  num(
    "dummy-volley-size",
    "Dummies",
    "Shots per volley",
    "",
    [1, 12, 1],
    "live",
    "How many shots in a volley.",
    true,
  ),
  num(
    "dummy-volley-spread",
    "Dummies",
    "Spread",
    "deg",
    [0, 45, 1],
    "live",
    "How far a volley fans out around the aim.",
  ),
  num(
    "dummy-range",
    "Dummies",
    "Sage wake range",
    "m",
    [5, 60, 1],
    "next sage",
    "How close Jak has to be for a dummy's sage to appear.",
  ),
  num(
    "dummy-leave-range",
    "Dummies",
    "Sage leave range",
    "m",
    [5, 80, 1],
    "next sage",
    "How far Jak has to be before the sage leaves. Keep it above the wake range.",
  ),
  num(
    "herald-range",
    "Dummies",
    "Herald wake range",
    "m",
    [5, 60, 1],
    "next sage",
    "How close Jak has to be for the herald to appear.",
  ),
  num(
    "herald-leave-range",
    "Dummies",
    "Herald leave range",
    "m",
    [5, 80, 1],
    "next sage",
    "How far Jak has to be before the herald leaves. Keep it above the wake range.",
  ),
  num(
    "dummy-shot-speed",
    "Dummies",
    "Shot speed",
    "m/s",
    [5, 100, 1],
    "next shot",
    "How fast the yellow eco shots fly.",
  ),
  flag(
    "stampede-enabled",
    "Stampede",
    "Sandover stampede",
    "live",
    "Coming near the spot beside the farmer in Sandover sends a herd charging from the Forbidden Jungle. The Stampede button still works when this is off.",
  ),
  num(
    "stampede-herd-size",
    "Stampede",
    "Herd size",
    "",
    [1, 30, 1],
    "next herd",
    "Yakows in the herd, three to a row. A bigger herd only adds rows behind; the first slots never move.",
    true,
  ),
  num(
    "stampede-speed",
    "Stampede",
    "Speed",
    "m/s",
    [4, 30, 1],
    "next herd",
    "How fast the yakows run. Jak runs at 10 m/s, so above that he has to sidestep rather than outrun them.",
  ),
  num(
    "stampede-trigger-radius",
    "Stampede",
    "Trigger radius",
    "m",
    [1, 20, 0.5],
    "live",
    "How close Jak has to get to the Sandover spot to set the herd off.",
  ),
  num(
    "stampede-rearm-range",
    "Stampede",
    "Rearm range",
    "m",
    [10, 200, 5],
    "live",
    "How far Jak has to walk away from the Sandover spot before the herd can charge again.",
  ),
  num(
    "stampede-red-count",
    "Stampede",
    "Red yakows",
    "",
    [0, 30, 1],
    "next herd",
    "How many yakows are charged with red eco, counted from the lead row. A red yakow costs two hits and throws Jak far.",
    true,
  ),
  flag(
    "yakow-stampede-enabled",
    "Stampede",
    "Hitting a yakow sends a herd",
    "live",
    "Hitting one of the farm's yakows sends a herd charging at Jak from behind it, one herd at a time. The Stampede button still works when this is off.",
  ),
  flag(
    "babak-charge-enabled",
    "Charged lurkers",
    "Charged babaks",
    "next babak",
    "Babaks are born charged with eco, on every level. Off leaves them as the game made them.",
  ),
  num(
    "babak-charge-chance",
    "Charged lurkers",
    "Charge chance",
    "",
    [0, 1, 0.05],
    "next babak",
    "The chance a babak is charged when it is born, rolled once. A charged one is red or blue by a coin toss: blue runs at Jak faster, red costs two hits and throws him far.",
  ),
  num(
    "babak-blue-speed",
    "Charged lurkers",
    "Blue speed",
    "x",
    [1, 4, 0.1],
    "next babak",
    "How many times faster a blue babak runs than a plain one. A babak keeps the pace it was born with.",
  ),
  flag(
    "worm-cubes-enabled",
    "Beach worms",
    "Worms raise ice cubes",
    "next rise",
    "Each time a lurkerworm rises out of the sand at Sentinel Beach it pulls Snowy Mountain ice cubes up out of the ground around it, tinted sand. They appear, turn mean, charge Jak, tire and shatter as they do on the mountain. Off leaves the worms as the game made them.",
  ),
  num(
    "worm-cube-count",
    "Beach worms",
    "Ice cubes per rise",
    "",
    [0, 8, 1],
    "next rise",
    "How many ice cubes a worm raises, evenly around it, the first on the side facing Jak. A worm raises a new wave only once the last one is gone.",
    true,
  ),
  num(
    "lurker-multiplier",
    "Horde",
    "Lurkers where there was one",
    "x",
    [1, 5, 1],
    "next birth",
    "Every lurker the level places on the nav mesh (babaks, lurker crabs, hoppers, bonelurkers, ice cubes and the rest) comes with company: this many of it in all, the original and the clones standing around it on a 3 m ring. 3 turns 1 into 3 and 2 into 6; 1 is the game's own. A clone drops pills, never the power cell. Lurkers already in the world keep the company they were born with; the clones go when their level does, or when Jak walks far enough away that the original is put away (they come back fresh with it).",
    true,
  ),
  num(
    "horde-max-clones",
    "Horde",
    "Clone cap",
    "",
    [0, 300, 5],
    "live",
    "The most clones alive at once, all groups together. A lurker born when the crowd is full gets only as many clones as fit, possibly none (the game logs it). Clones already standing are never taken away for it; lowering it only stops new ones until the crowd thins. 0 turns the clones off without touching the multiplier.",
    true,
  ),
  flag(
    "klaww-enabled",
    "Klaww",
    "Klaww",
    "live",
    "Klaww falls onto the pelican when it lands at its nest at Sentinel Beach and throws boulders at Jak; the buttons around the beach throw boulders back, one hit each, and every button counts. Jak dying does not end the fight: Klaww comes back with the hits he had and the pressed buttons stay pressed. Off takes him and the buttons away and forgets the fight. The Klaww falls button still needs this on.",
  ),
  num(
    "klaww-throw-interval",
    "Klaww",
    "Throw interval",
    "s",
    [1, 20, 0.5],
    "live",
    "Time from one boulder leaving his hand to the next, wind-up included. A throw takes as long as its animation, so very low values change little.",
  ),
  num(
    "klaww-range",
    "Klaww",
    "Throwing range",
    "m",
    [20, 300, 5],
    "live",
    "He throws while Jak is this close to the nest. The first button is about 100 m from it, so the default keeps Jak a target while he presses it.",
  ),
  num(
    "klaww-boulder-radius",
    "Klaww",
    "Boulder hit radius",
    "m",
    [1, 15, 0.5],
    "next boulder",
    "Jak is hit if he is this close to where a boulder lands. The orange ring on the ground is this wide.",
  ),
  flag(
    "tnt-enabled",
    "TNT barrels",
    "Skull TNT barrels",
    "live",
    "Mountain Pass's skull TNT barrels stand where the designer picked a spot for one (the first is on Sentinel Beach, between a power cell and the ground below it). Touching or attacking one kills Jak outright and the barrel explodes. A barrel that is gone stands again once Jak is more than 30 m from its spot. Off puts every barrel away and spawns none.",
  ),
];

const SPEC_BY_KEY = new Map(SETTINGS.map((spec) => [spec.key, spec]));

function isValueFor(spec: SettingSpec, value: unknown): value is SettingValue {
  if (spec.kind === "boolean") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value < spec.min || value > spec.max) return false;
  return !spec.integer || Number.isInteger(value);
}

// ---------------------------------------------------------------------------
// Warp destinations: continue names the game understands.
// Sources (other files, not modules, so copied here):
//   - *twitch-warp-points* in goal_src/jak1/pc/features/twitch.gc (the 15 checkpoints)
//   - WARPS in ~/dev/private/streamkit/server.js, which adds game-start (Geyser Rock)
//     and jungle-tower on top of those.
// ---------------------------------------------------------------------------

interface WarpPoint {
  id: string;
  label: string;
}

const WARP_POINTS: readonly WarpPoint[] = [
  { id: "random", label: "Random checkpoint" },
  { id: "game-start", label: "Geyser Rock" },
  { id: "village1-warp", label: "Sandover Village (green)" },
  { id: "beach-start", label: "Sentinel Beach" },
  { id: "jungle-start", label: "Forbidden Jungle" },
  { id: "jungle-tower", label: "Forbidden Jungle, tower" },
  { id: "misty-start", label: "Misty Island" },
  { id: "firecanyon-start", label: "Fire Canyon" },
  { id: "village2-warp", label: "Rock Village (blue)" },
  { id: "swamp-start", label: "Boggy Swamp" },
  { id: "sunken-start", label: "Lost Precursor City" },
  { id: "rolling-start", label: "Precursor Basin" },
  { id: "ogre-start", label: "Mountain Pass" },
  { id: "village3-warp", label: "Volcanic Crater (red)" },
  { id: "maincave-start", label: "Spider Cave" },
  { id: "snow-start", label: "Snowy Mountain" },
  { id: "lavatube-start", label: "Lava Tube" },
  { id: "citadel-start", label: "Gol and Maia's Citadel" },
];

// ---------------------------------------------------------------------------
// Game state: validated, never cast.
// ---------------------------------------------------------------------------

interface JakState {
  x: number;
  y: number;
  z: number;
  onGround: boolean;
}
interface BombState {
  state: string;
  x: number;
  y: number;
  z: number;
  remaining: number;
  /** null when there is no Jak to measure against. */
  jakDistance: number | null;
}
/** A spot where the bomb drops by itself on Geyser Rock: the bridge, the vent. */
interface DropSpotState {
  armed: boolean;
  distance: number;
}
interface KlawwState {
  /** Where the fight is: waiting for the pelican, falling, landing, fighting, or defeated. */
  state: string;
  /** Boulders that have reached him since this fight began; a death does not take them away. */
  hits: number;
  /** Hits it takes to bring him down: one per button. */
  max: number;
  /** In the world and not yet beaten. */
  alive: boolean;
  /** Buttons whose boulder has reached him, which stay pressed through a death. */
  buttonsPressed: number;
  /** Buttons on the beach. */
  buttons: number;
}
interface HordeState {
  /** Watchers alive: one per lurker that was born with clones still standing. */
  groups: number;
  /** Clones alive across all groups. */
  clones: number;
  /** The cap on clones alive (the horde-max-clones setting in effect). */
  max: number;
  /** The lurker multiplier in effect (the lurker-multiplier setting). */
  multiplier: number;
}
interface GauntletState {
  frame: number;
  revision: number;
  settings: SettingMap;
  defaults: SettingMap;
  level: string;
  jak: JakState | null;
  bomb: BombState | null;
  bridge: DropSpotState | null;
  /** null off Geyser Rock, and for a game build that has no vent spot. */
  vent: DropSpotState | null;
  /** null unless Jak is on the beach or a fight is on, and for a game build that does not publish him. */
  klaww: KlawwState | null;
  /** null only for a game build that does not publish the horde. */
  horde: HordeState | null;
  effects: { enabled: boolean };
}

class ShapeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function needRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ShapeError(`${path} is not an object`);
  return value;
}
function needNumber(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ShapeError(`${path}.${key} is not a number`);
  }
  return value;
}
function needBoolean(source: Record<string, unknown>, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new ShapeError(`${path}.${key} is not a boolean`);
  return value;
}
function needString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new ShapeError(`${path}.${key} is not a string`);
  return value;
}
function orNull<T>(value: unknown, parse: (inner: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

/** Keep only known keys whose value fits their spec; the game may know more than we present. */
function pickKnownSettings(value: unknown, path: string): SettingMap {
  const source = needRecord(value, path);
  const picked: SettingMap = {};
  for (const [key, entry] of Object.entries(source)) {
    const spec = SPEC_BY_KEY.get(key);
    if (spec === undefined) continue;
    // the game is the source of truth: check the kind only, not our slider range
    if (typeof entry === "boolean" && spec.kind === "boolean") picked[key] = entry;
    if (typeof entry === "number" && Number.isFinite(entry) && spec.kind === "number") {
      picked[key] = entry;
    }
  }
  return picked;
}

function parseDropSpot(value: unknown, path: string): DropSpotState {
  const spot = needRecord(value, path);
  return { armed: needBoolean(spot, "armed", path), distance: needNumber(spot, "distance", path) };
}

function parseGauntletState(raw: unknown): GauntletState {
  const root = needRecord(raw, "state");
  return {
    frame: needNumber(root, "frame", "state"),
    revision: needNumber(root, "revision", "state"),
    settings: pickKnownSettings(root.settings, "state.settings"),
    defaults: pickKnownSettings(root.defaults, "state.defaults"),
    level: needString(root, "level", "state"),
    jak: orNull(root.jak, (value) => {
      const jak = needRecord(value, "state.jak");
      return {
        x: needNumber(jak, "x", "state.jak"),
        y: needNumber(jak, "y", "state.jak"),
        z: needNumber(jak, "z", "state.jak"),
        onGround: needBoolean(jak, "onGround", "state.jak"),
      };
    }),
    bomb: orNull(root.bomb, (value) => {
      const bomb = needRecord(value, "state.bomb");
      return {
        state: needString(bomb, "state", "state.bomb"),
        x: needNumber(bomb, "x", "state.bomb"),
        y: needNumber(bomb, "y", "state.bomb"),
        z: needNumber(bomb, "z", "state.bomb"),
        remaining: needNumber(bomb, "remaining", "state.bomb"),
        jakDistance:
          bomb.jakDistance === null ? null : needNumber(bomb, "jakDistance", "state.bomb"),
      };
    }),
    bridge: orNull(root.bridge, (value) => parseDropSpot(value, "state.bridge")),
    vent:
      root.vent === undefined
        ? null
        : orNull(root.vent, (value) => parseDropSpot(value, "state.vent")),
    klaww:
      root.klaww === undefined
        ? null
        : orNull(root.klaww, (value) => {
            const klaww = needRecord(value, "state.klaww");
            return {
              state: needString(klaww, "state", "state.klaww"),
              hits: needNumber(klaww, "hits", "state.klaww"),
              max: needNumber(klaww, "max", "state.klaww"),
              alive: needBoolean(klaww, "alive", "state.klaww"),
              buttonsPressed: needNumber(klaww, "buttonsPressed", "state.klaww"),
              buttons: needNumber(klaww, "buttons", "state.klaww"),
            };
          }),
    horde:
      root.horde === undefined
        ? null
        : orNull(root.horde, (value) => {
            const horde = needRecord(value, "state.horde");
            return {
              groups: needNumber(horde, "groups", "state.horde"),
              clones: needNumber(horde, "clones", "state.horde"),
              max: needNumber(horde, "max", "state.horde"),
              multiplier: needNumber(horde, "multiplier", "state.horde"),
            };
          }),
    effects: {
      enabled: needBoolean(needRecord(root.effects, "state.effects"), "enabled", "state.effects"),
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the game's state file: last good parse wins over a torn read.
// ---------------------------------------------------------------------------

interface StateSnapshot {
  state: GauntletState | null;
  /** Wall-clock time the frame counter last changed (first sight: the file's mtime). */
  frameChangedAt: number | null;
  /** Why the latest read was rejected, or null when it parsed. */
  error: string | null;
}

const snapshot: StateSnapshot = { state: null, frameChangedAt: null, error: null };

async function refreshState(): Promise<void> {
  try {
    const [text, info] = await Promise.all([readFile(STATE_FILE, "utf8"), stat(STATE_FILE)]);
    const parsed = parseGauntletState(JSON.parse(text));
    if (snapshot.state === null) snapshot.frameChangedAt = info.mtimeMs;
    else if (parsed.frame !== snapshot.state.frame) snapshot.frameChangedAt = Date.now();
    snapshot.state = parsed;
    snapshot.error = null;
  } catch (error) {
    if (isMissingFile(error)) {
      snapshot.error = null;
      return;
    }
    snapshot.error = error instanceof Error ? error.message : String(error);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// ---------------------------------------------------------------------------
// Settings file: lisp forms, one per line.
// ---------------------------------------------------------------------------

interface SettingsFile {
  revision: number;
  settings: SettingMap;
}

function parseSettingsFile(text: string): SettingsFile {
  let revision = 0;
  const settings: SettingMap = {};
  for (const line of text.split("\n")) {
    const form = /^\(([a-z0-9-]+)\s+(#t|#f|-?\d+(?:\.\d+)?)\)\s*$/.exec(line.trim());
    if (form === null) continue;
    const [, key, token] = form;
    if (key === undefined || token === undefined) continue;
    if (key === "revision") {
      revision = Number(token);
      continue;
    }
    const spec = SPEC_BY_KEY.get(key);
    if (spec === undefined) continue;
    const value = token === "#t" ? true : token === "#f" ? false : Number(token);
    if (isValueFor(spec, value)) settings[key] = value;
  }
  return { revision, settings };
}

async function readSettingsFile(): Promise<SettingsFile | null> {
  try {
    return parseSettingsFile(await readFile(SETTINGS_FILE, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function formatSettingValue(spec: SettingSpec, value: SettingValue): string {
  if (typeof value === "boolean") return value ? "#t" : "#f";
  if (spec.kind === "number" && spec.integer) return String(Math.round(value));
  const rounded = Number(value.toFixed(4));
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

function formatSettingsFile(revision: number, settings: SettingMap): string {
  const lines = [`(revision ${revision})`];
  for (const spec of SETTINGS) {
    const value = settings[spec.key];
    if (value !== undefined) lines.push(`(${spec.key} ${formatSettingValue(spec, value)})`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, content);
  await rename(temp, path);
}

/** Serializes read-modify-write cycles so two requests never interleave on one file. */
function makeSerial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
const serializeSettings = makeSerial();
const serializeDrops = makeSerial();

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function validatePatch(body: unknown): SettingMap {
  if (!isRecord(body)) throw new HttpError(400, "body must be a JSON object of setting values");
  const entries = Object.entries(body);
  if (entries.length === 0) throw new HttpError(400, "no settings given");
  const patch: SettingMap = {};
  for (const [key, value] of entries) {
    const spec = SPEC_BY_KEY.get(key);
    if (spec === undefined) throw new HttpError(400, `unknown setting: ${key}`);
    if (!isValueFor(spec, value)) {
      throw new HttpError(400, `bad value for ${key}: ${describeSpec(spec)}`);
    }
    patch[key] = value;
  }
  return patch;
}

function describeSpec(spec: SettingSpec): string {
  if (spec.kind === "boolean") return "expected true or false";
  const whole = spec.integer ? " whole number" : " number";
  return `expected a${whole} from ${spec.min} to ${spec.max}`;
}

/** Start from the file if present, else the game's settings, else nothing. */
async function baseForWrite(): Promise<SettingsFile> {
  const file = await readSettingsFile();
  const inGame = snapshot.state;
  // the game resets every setting to its default on a new revision and then applies the
  // file's keys, so always write the full key set: defaults underneath, then what is in force
  const base = { ...inGame?.defaults, ...(file?.settings ?? inGame?.settings) };
  const revision = Math.max(file?.revision ?? 0, inGame?.revision ?? 0);
  return { revision, settings: { ...base } };
}

async function saveSettings(
  patch: SettingMap,
): Promise<{ revision: number; settings: SettingMap }> {
  return serializeSettings(async () => {
    await refreshState();
    const base = await baseForWrite();
    const settings = { ...base.settings, ...patch };
    const revision = base.revision + 1;
    await writeAtomically(SETTINGS_FILE, formatSettingsFile(revision, settings));
    return { revision, settings };
  });
}

async function resetSettings(): Promise<{ revision: number; settings: SettingMap }> {
  return serializeSettings(async () => {
    await refreshState();
    if (snapshot.state === null) {
      throw new HttpError(409, "the game has not reported its defaults yet");
    }
    const base = await baseForWrite();
    const settings: SettingMap = { ...snapshot.state.defaults };
    const revision = base.revision + 1;
    await writeAtomically(SETTINGS_FILE, formatSettingsFile(revision, settings));
    return { revision, settings };
  });
}

// ---------------------------------------------------------------------------
// Triggers.
// ---------------------------------------------------------------------------

/** What the game's drop request channel (`gauntlet-drop-request.txt`) understands. */
const DROP_WORDS = ["bomb", "bomb-bridge", "bomb-vent", "stampede", "klaww"] as const;
type DropWord = (typeof DROP_WORDS)[number];

function isDropWord(value: unknown): value is DropWord {
  return DROP_WORDS.some((word) => word === value);
}

const ACTIONS = [...DROP_WORDS, "trip", "freeze", "warp", "say", "save-spot", "load-spot"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: unknown): value is Action {
  return ACTIONS.some((action) => action === value);
}

async function writeDropRequest(word: DropWord): Promise<number> {
  return serializeDrops(async () => {
    let previous = 0;
    try {
      const match = /^\s*(\d+)/.exec(await readFile(DROP_FILE, "utf8"));
      if (match?.[1] !== undefined) previous = Number(match[1]);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const counter = previous + 1;
    await writeFile(DROP_FILE, `${counter} ${word}\n`);
    return counter;
  });
}

interface QueuedCommand {
  line: string;
  isWritten: boolean;
}
const commandQueue: QueuedCommand[] = [];
let isPumping = false;

/** The game truncates the command file after reading it, so empty or missing means free. */
async function isCommandChannelIdle(): Promise<boolean> {
  try {
    return (await readFile(COMMAND_FILE, "utf8")).trim().length === 0;
  } catch (error) {
    if (isMissingFile(error)) return true;
    throw error;
  }
}

async function pumpCommands(): Promise<void> {
  if (isPumping || commandQueue.length === 0) return;
  isPumping = true;
  try {
    const next = commandQueue[0];
    if (next !== undefined && (await isCommandChannelIdle())) {
      await writeFile(COMMAND_FILE, next.line);
      next.isWritten = true;
      commandQueue.shift();
    }
  } catch (error) {
    console.error("command write failed:", error instanceof Error ? error.message : error);
  } finally {
    isPumping = false;
  }
}
setInterval(pumpCommands, COMMAND_RETRY_MS).unref();

async function sendCommand(line: string): Promise<{ written: true } | { queued: true }> {
  const command: QueuedCommand = { line, isWritten: false };
  commandQueue.push(command);
  await pumpCommands();
  return command.isWritten ? { written: true } : { queued: true };
}

function commandLine(action: Action, arg: unknown): string {
  switch (action) {
    case "trip":
    case "freeze":
    case "save-spot":
    case "load-spot":
      return `${action} console\n`;
    case "warp": {
      if (!WARP_POINTS.some((point) => point.id === arg)) {
        throw new HttpError(400, "warp needs one of the destinations from /api/warps");
      }
      return `warp console ${arg}\n`;
    }
    case "say": {
      if (typeof arg !== "string" || !/^[\w-]+( [\w-]+)?$/.test(arg)) {
        throw new HttpError(400, "say needs a cue, optionally followed by a language");
      }
      return `say console ${arg}\n`;
    }
    case "bomb":
    case "bomb-bridge":
    case "bomb-vent":
    case "stampede":
    case "klaww":
      throw new HttpError(500, "drops do not use the command file");
  }
}

async function runTrigger(body: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(body) || !isAction(body.action)) {
    throw new HttpError(400, `action must be one of: ${ACTIONS.join(", ")}`);
  }
  const action = body.action;
  if (isDropWord(action)) {
    return { written: true, counter: await writeDropRequest(action) };
  }
  return sendCommand(commandLine(action, body.arg));
}

// ---------------------------------------------------------------------------
// HTTP.
// ---------------------------------------------------------------------------

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += piece.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(piece);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

async function stateResponse() {
  await refreshState();
  const frameChangedAt = snapshot.frameChangedAt;
  const ageMs = frameChangedAt === null ? null : Math.max(0, Date.now() - frameChangedAt);
  const isGameLive = ageMs !== null && ageMs <= LIVE_WINDOW_MS;
  const written = await readSettingsFile();
  return {
    live: isGameLive,
    ageMs,
    state: snapshot.state,
    stateError: snapshot.error,
    written,
  };
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { pathname } = new URL(request.url ?? "/", `http://${HOST}`);
  const method = request.method ?? "GET";

  if (method === "GET" && pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(await readFile(INDEX_FILE));
    return;
  }
  if (method === "GET" && pathname === "/api/state") {
    return sendJson(response, 200, await stateResponse());
  }
  if (method === "GET" && pathname === "/api/schema") {
    return sendJson(response, 200, SETTINGS);
  }
  if (method === "GET" && pathname === "/api/warps") {
    return sendJson(response, 200, WARP_POINTS);
  }
  if (method === "POST" && pathname === "/api/settings") {
    const saved = await saveSettings(validatePatch(await readJson(request)));
    return sendJson(response, 200, saved);
  }
  if (method === "POST" && pathname === "/api/settings/reset") {
    return sendJson(response, 200, await resetSettings());
  }
  if (method === "POST" && pathname === "/api/trigger") {
    return sendJson(response, 200, await runTrigger(await readJson(request)));
  }
  throw new HttpError(404, "not found");
}

const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    if (error instanceof HttpError)
      return sendJson(response, error.status, { error: error.message });
    console.error(error);
    return sendJson(response, 500, { error: "internal error" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`gauntlet console: http://${HOST}:${PORT}/  (mods dir: ${MODS_DIR})`);
});
