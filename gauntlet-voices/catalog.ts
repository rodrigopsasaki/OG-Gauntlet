// The voice catalog: every ripped English voice clip, joined to its subtitle text and speaker.
//
// Two join keys, because the game names its audio two ways:
//   hints     subtitle "hints" are keyed by the clip's own name (ASSTLP01, sksp0398, ...), case-insensitively.
//   cutscenes subtitle "cutscenes" are keyed by the scene name (billy-accept). The ripper's file_list.txt
//             carries each clip's original source name, cut to 16 characters ("assistant-fireca"), so a
//             clip joins to the scene whose name starts with it. A tie between scenes sharing that prefix
//             is broken by the clip's own abbreviation (AS2IFLUT is a subsequence of
//             assistant-village2-introduction-flutflut), shortest scene first.
// Speakers come from the subtitle meta file: one entry per spoken line, plus "clear" entries that only
// blank the screen and carry no text.
// Clips the subtitles do not know (about a third of them) get no speaker from the join. Some are voice
// the game simply never subtitled (Daxter's quips, Keira's and Samos's lip-flap lines); the rest are sound
// effects and music stingers. Name families tell the two apart, see familySpeakers.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

const GAUNTLET_DIR = join(import.meta.dirname, "..");
export const VOICE_DIR = join(GAUNTLET_DIR, "decompiler_out", "jak1", "audio", "voice_lines");
export const ENGLISH_DIR = join(VOICE_DIR, "ENG");
const FILE_LIST = join(VOICE_DIR, "file_list.txt");
const SUBTITLE_DIR = join(GAUNTLET_DIR, "game", "assets", "jak1", "subtitle");

export const RIP_HINT =
  "Rip them with the OpenGOAL decompiler (rip_streamed_audio) and copy audio/voice_lines/ENG and file_list.txt into the voice_lines folder.";

export type Voice = {
  /** The clip's file name without extension, as ripped. */
  name: string;
  /** Absolute path to the wav. */
  file: string;
  /** Distinct speakers in order of appearance, joined with "+". Empty when unknown. */
  speaker: string;
  /** Speaker guessed from the clip's name family when no subtitle names one. Empty otherwise. */
  inferredSpeaker: string;
  /** Every subtitle line joined into one string. Empty when the clip has no subtitle. */
  text: string;
  /** Where the subtitle came from, or "none". */
  source: "hint" | "cutscene" | "none";
  /** The scene name, when the clip joined through a cutscene. */
  scene: string;
  seconds: number;
};

type Lines = Record<string, string[]>;
type MetaEntry = { clear: boolean; speaker: string };
type SubtitleLines = { cutscenes: Lines; hints: Lines };
type SubtitleMeta = {
  cutscenes: Record<string, MetaEntry[]>;
  hints: Record<string, { lines: MetaEntry[] }>;
};

/**
 * How many words must be skipped for `abbreviation` to read as the scene name spelled in per-word
 * prefixes, in order (AS2IFLUT is "as"(sistant) "2"(village2) "i"(ntroduction) "flut"(flutflut)),
 * or Infinity when it cannot be spelled that way.
 */
function skippedWords(abbreviation: string, words: string[]): number {
  const [word, ...rest] = words;
  if (abbreviation === "") return words.length;
  if (word === undefined) return Number.POSITIVE_INFINITY;
  let fewest = 1 + skippedWords(abbreviation, rest);
  const digits = /\d+$/.exec(word)?.[0];
  if (digits !== undefined && abbreviation.startsWith(digits)) {
    fewest = Math.min(fewest, skippedWords(abbreviation.slice(digits.length), rest));
  }
  for (let take = Math.min(word.length, abbreviation.length); take > 0; take -= 1) {
    if (abbreviation.startsWith(word.slice(0, take))) {
      fewest = Math.min(fewest, skippedWords(abbreviation.slice(take), rest));
    }
  }
  return fewest;
}

/** Longest common subsequence length, for abbreviations that are not a pure spelling (the Z in GEZMOLES). */
function commonLength(a: string, b: string): number {
  let row: number[] = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const next: number[] = [0];
    for (let j = 1; j <= b.length; j += 1) {
      const diagonal = row[j - 1] ?? 0;
      next[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j] ?? 0, next[j - 1] ?? 0);
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/** Duration of a PCM wav, read from its header alone. 0 when the header is not recognized. */
export function wavSeconds(file: string): number {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(128);
    const got = readSync(fd, head, 0, head.length, 0);
    const isWave = got >= 44 && head.toString("ascii", 0, 4) === "RIFF";
    const dataAt = head.indexOf("data");
    if (!isWave || dataAt < 0) return 0;
    const byteRate = head.readUInt32LE(28);
    return byteRate === 0 ? 0 : head.readUInt32LE(dataAt + 4) / byteRate;
  } finally {
    closeSync(fd);
  }
}

/** Source names for a clip from file_list.txt: lowercase, extensions dropped, garbage paths ignored. */
function sourceNames(row: string[]): string[] {
  const names = row
    .slice(1)
    .filter((cell) => !cell.startsWith("Z:"))
    .map((cell) => cell.toLowerCase().replace(/\.\w{0,3}$/, ""));
  return [...new Set(names)];
}

function pickScene(vag: string, row: string[] | undefined, scenes: string[]): string | undefined {
  const abbreviation = vag.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = row ? sourceNames(row) : [];
  const named = scenes.filter((scene) =>
    names.some((name) => scene === name || (name.length === 16 && scene.startsWith(name))),
  );
  const spelled = (pool: string[]) =>
    pool
      .map((scene) => ({ scene, skipped: skippedWords(abbreviation, scene.split("-")) }))
      .filter((fit) => Number.isFinite(fit.skipped))
      .sort((a, b) => a.skipped - b.skipped || a.scene.length - b.scene.length)
      .map((fit) => fit.scene);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    const exact = spelled(named);
    if (exact.length > 0) return exact[0];
    const score = (scene: string) => commonLength(abbreviation, scene.replace(/[^a-z0-9]/g, ""));
    const ranked = [...named].sort((a, b) => score(b) - score(a));
    const [best, runnerUp] = ranked;
    const unambiguous = best !== undefined && score(best) > score(runnerUp ?? "");
    return unambiguous && score(best) >= abbreviation.length - 1 ? best : undefined;
  }
  // No source name to go on: trust the spelling alone, only when long enough to mean something and unique.
  const fits = spelled(scenes);
  return abbreviation.length >= 6 && fits.length === 1 ? fits[0] : undefined;
}

function speakersOf(entries: MetaEntry[]): string[] {
  return entries.filter((entry) => !entry.clear).map((entry) => entry.speaker);
}

function describe(lines: string[], entries: MetaEntry[]): { speaker: string; text: string } {
  const speakers = speakersOf(entries);
  const distinct = [...new Set(speakers.filter((speaker) => speaker !== ""))];
  return { speaker: distinct.join("+"), text: lines.join(" ") };
}

/** The clip name up to its first digit: ASSTVB01 is "ASSTVB", BIR-LO2A is "BIR-LO", BIR1 is "BIR". */
function familyOf(name: string): string {
  const upper = name.toUpperCase();
  return /^[A-Z]+(?:-[A-Z]+)?/.exec(upper)?.[0] ?? upper;
}

function firstSpeaker(speaker: string): string {
  return speaker.split("+")[0] ?? "";
}

/**
 * The game names a clip's family after who talks in it and where: SAGELP and SAGEVB are Samos (41 for 41
 * subtitled), ASSTLP and ASSTVB are Keira, SKSP is Daxter (254 for 254), BIR-LO is the bird watcher, and
 * BIL-TA is Billy, whose BIL-TA6A is the "A" take of BIL-TA06. A family whose subtitled clips all open
 * with one speaker lends that speaker to its unsubtitled siblings. A family with no subtitled clip at all
 * (GAMCAM, FUCV, ST-WIN) or with mixed speakers lends nothing, and its clips stay sound effects.
 */
function familySpeakers(voices: Voice[]): Map<string, string> {
  const openers = new Map<string, Set<string>>();
  for (const voice of voices) {
    if (voice.speaker === "") continue;
    const family = familyOf(voice.name);
    openers.set(family, (openers.get(family) ?? new Set()).add(firstSpeaker(voice.speaker)));
  }
  const lent = new Map<string, string>();
  for (const [family, speakers] of openers) {
    const [only] = speakers;
    if (only !== undefined && speakers.size === 1) lent.set(family, only);
  }
  return lent;
}

/** What the actor column says for clips nobody speaks in: sound effects, jingles, music stingers. */
export const SFX = "sfx";

/** The full "a+b" speaker label of a clip, its inferred speaker, or "sfx". */
export function actorLabel(voice: Voice): string {
  if (voice.speaker !== "") return voice.speaker;
  return voice.inferredSpeaker === "" ? SFX : voice.inferredSpeaker;
}

/** The actor a clip is filed under: the first of its speakers. */
export function actorOf(voice: Voice): string {
  return firstSpeaker(actorLabel(voice));
}

export function actorCounts(voices: Voice[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const voice of voices) counts.set(actorOf(voice), (counts.get(actorOf(voice)) ?? 0) + 1);
  return counts;
}

/** Group clips by actor, biggest group first and sfx last; clips keep their order within a group. */
export function groupByActor(voices: Voice[]): Voice[] {
  const counts = actorCounts(voices);
  const size = (actor: string) => (actor === SFX ? -1 : (counts.get(actor) ?? 0));
  return [...voices].sort((a, b) => {
    const left = actorOf(a);
    const right = actorOf(b);
    if (left === right) return 0;
    return size(right) - size(left) || (left < right ? -1 : 1);
  });
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function hasAudio(): boolean {
  return existsSync(ENGLISH_DIR);
}

export function loadCatalog(): Voice[] {
  const subtitles = readJson<SubtitleLines>(join(SUBTITLE_DIR, "subtitle_lines_en-US.json"));
  const meta = readJson<SubtitleMeta>(join(SUBTITLE_DIR, "subtitle_meta_en-US.json"));
  const hintKey = new Map(Object.keys(subtitles.hints).map((key) => [key.toUpperCase(), key]));
  const sceneNames = Object.keys(subtitles.cutscenes);
  const rows = new Map<string, string[]>();
  if (existsSync(FILE_LIST)) {
    const list = readJson<{ names: string[][] }>(FILE_LIST);
    for (const row of list.names) {
      const vag = row[0];
      if (vag !== undefined) rows.set(vag.toUpperCase(), row);
    }
  }

  const voices: Voice[] = [];
  for (const entry of readdirSync(ENGLISH_DIR)) {
    if (!entry.toLowerCase().endsWith(".wav")) continue;
    const name = entry.slice(0, -4);
    const file = join(ENGLISH_DIR, entry);
    const seconds = wavSeconds(file);
    const hint = hintKey.get(name.toUpperCase());
    const hintLines = hint === undefined ? undefined : subtitles.hints[hint];
    const hintMeta = hint === undefined ? undefined : meta.hints[hint]?.lines;
    if (hintLines !== undefined) {
      voices.push({
        name,
        file,
        ...describe(hintLines, hintMeta ?? []),
        inferredSpeaker: "",
        source: "hint",
        scene: "",
        seconds,
      });
      continue;
    }
    const scene = pickScene(name, rows.get(name.toUpperCase()), sceneNames);
    const sceneLines = scene === undefined ? undefined : subtitles.cutscenes[scene];
    if (scene !== undefined && sceneLines !== undefined) {
      voices.push({
        name,
        file,
        ...describe(sceneLines, meta.cutscenes[scene] ?? []),
        inferredSpeaker: "",
        source: "cutscene",
        scene,
        seconds,
      });
      continue;
    }
    voices.push({
      name,
      file,
      speaker: "",
      inferredSpeaker: "",
      text: "",
      source: "none",
      scene: "",
      seconds,
    });
  }
  voices.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const speakerOfFamily = familySpeakers(voices);
  return voices.map((voice) =>
    voice.speaker === ""
      ? { ...voice, inferredSpeaker: speakerOfFamily.get(familyOf(voice.name)) ?? "" }
      : voice,
  );
}
