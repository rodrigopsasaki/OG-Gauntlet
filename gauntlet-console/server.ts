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

type SettingGroup = "Bomb" | "Geyser bridge" | "Dummies";
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
    "Geyser bridge",
    "Bridge bomb",
    "live",
    "Walking up to the Geyser bridge arms a bomb that drops on it.",
  ),
  num(
    "bridge-trigger-radius",
    "Geyser bridge",
    "Trigger radius",
    "m",
    [1, 20, 0.5],
    "live",
    "How close Jak has to get to the bridge spot to set it off.",
  ),
  num(
    "bridge-rearm-range",
    "Geyser bridge",
    "Rearm range",
    "m",
    [10, 200, 5],
    "live",
    "How far Jak has to walk away before the bridge can fire again.",
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
  jakDistance: number;
}
interface BridgeState {
  armed: boolean;
  distance: number;
}
interface GauntletState {
  frame: number;
  revision: number;
  settings: SettingMap;
  defaults: SettingMap;
  level: string;
  jak: JakState | null;
  bomb: BombState | null;
  bridge: BridgeState | null;
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
        jakDistance: needNumber(bomb, "jakDistance", "state.bomb"),
      };
    }),
    bridge: orNull(root.bridge, (value) => {
      const bridge = needRecord(value, "state.bridge");
      return {
        armed: needBoolean(bridge, "armed", "state.bridge"),
        distance: needNumber(bridge, "distance", "state.bridge"),
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
const serializeBombs = makeSerial();

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
  const base = file?.settings ?? inGame?.settings ?? {};
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

const ACTIONS = [
  "bomb",
  "bomb-bridge",
  "trip",
  "freeze",
  "warp",
  "say",
  "save-spot",
  "load-spot",
] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: unknown): value is Action {
  return ACTIONS.some((action) => action === value);
}

async function dropBomb(word: "bomb" | "bomb-bridge"): Promise<number> {
  return serializeBombs(async () => {
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
      throw new HttpError(500, "bombs do not use the command file");
  }
}

async function runTrigger(body: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(body) || !isAction(body.action)) {
    throw new HttpError(400, `action must be one of: ${ACTIONS.join(", ")}`);
  }
  const action = body.action;
  if (action === "bomb" || action === "bomb-bridge") {
    return { written: true, counter: await dropBomb(action) };
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
