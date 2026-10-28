// Voice line picker: listen to every Jak 1 voice clip and pick the ones the mod should use.
//
//   node gauntlet-voices/voices.ts
//
// Full-screen list, vim keys, no dependencies. Playback is macOS afplay, one clip at a time.
// Picks are written to picks.json beside this file on every toggle, so closing the terminal loses nothing.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGLISH_DIR, hasAudio, loadCatalog, RIP_HINT, type Voice } from "./catalog.ts";

const PICKS_FILE = join(import.meta.dirname, "picks.json");

// ---------------------------------------------------------------------------
// Picks: what Rodrigo chose, kept as plain records so the file reads on its own.
// ---------------------------------------------------------------------------

type Pick = { name: string; speaker: string; text: string };

function loadPicks(): Map<string, Pick> {
  const picks = new Map<string, Pick>();
  if (!existsSync(PICKS_FILE)) return picks;
  const stored: unknown = JSON.parse(readFileSync(PICKS_FILE, "utf8"));
  if (!Array.isArray(stored)) throw new Error(`${PICKS_FILE} must hold a JSON array`);
  for (const item of stored) {
    if (typeof item?.name === "string") {
      picks.set(item.name, {
        name: item.name,
        speaker: typeof item.speaker === "string" ? item.speaker : "",
        text: typeof item.text === "string" ? item.text : "",
      });
    }
  }
  return picks;
}

function savePicks(picks: Map<string, Pick>): void {
  const sorted = [...picks.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const scratch = `${PICKS_FILE}.tmp`;
  writeFileSync(scratch, `${JSON.stringify(sorted, null, 2)}\n`);
  renameSync(scratch, PICKS_FILE);
}

// ---------------------------------------------------------------------------
// Terminal: escape codes, key decoding, and fitting text to a width.
// ---------------------------------------------------------------------------

const ESC = "\x1b";
const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?25l`;
const LEAVE_SCREEN = `${ESC}[?25h${ESC}[?1049l`;
const RESET = `${ESC}[0m`;
const REVERSE = `${ESC}[7m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;

/** Cut to `width` columns, padding short text; long text ends in "..." so truncation is visible. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);
  return width <= 3 ? text.slice(0, width) : `${text.slice(0, width - 3)}...`;
}

/** Break a key stream into named keys. A lone ESC is the Escape key; ESC [ ... is an arrow or page key. */
function decodeKeys(chunk: string): string[] {
  const keys: string[] = [];
  const named: Record<string, string> = {
    "\r": "enter",
    "\n": "enter",
    "\x7f": "backspace",
    "\b": "backspace",
    "\x03": "ctrl-c",
    "\x04": "ctrl-d",
    "\x15": "ctrl-u",
  };
  const csi: Record<string, string> = {
    A: "up",
    B: "down",
    "5~": "pageup",
    "6~": "pagedown",
    H: "home",
    F: "end",
  };
  const chars = [...chunk];
  for (let at = 0; at < chars.length; at += 1) {
    const ch = chars[at] ?? "";
    if (ch !== ESC) {
      keys.push(named[ch] ?? ch);
      continue;
    }
    const next = chars[at + 1];
    if (next !== "[" && next !== "O") {
      keys.push("escape");
      continue;
    }
    let end = at + 2;
    while (end < chars.length && /[0-9;]/.test(chars[end] ?? "")) end += 1;
    const sequence = chars.slice(at + 2, end + 1).join("");
    keys.push(csi[sequence] ?? "unknown");
    at = end;
  }
  return keys;
}

// ---------------------------------------------------------------------------
// The picker.
// ---------------------------------------------------------------------------

type Search = { voice: Voice; haystack: string };

function main(): void {
  if (!hasAudio()) {
    console.error(`No voice clips at ${ENGLISH_DIR}. ${RIP_HINT}`);
    process.exit(1);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("gauntlet-voices needs an interactive terminal.");
    process.exit(1);
  }

  const catalog = loadCatalog();
  const searchable: Search[] = catalog.map((voice) => ({
    voice,
    haystack: `${voice.name} ${voice.scene} ${voice.speaker} ${voice.text}`.toLowerCase(),
  }));
  const picks = loadPicks();

  let view: Voice[] = catalog;
  let cursor = 0;
  let top = 0;
  let filter = "";
  let typing = false;
  let pickedOnly = false;
  let pendingG = false;
  let status = "";
  let playing: { voice: Voice; child: ChildProcess } | undefined;

  const columns = () => process.stdout.columns || 80;
  const rows = () => process.stdout.rows || 24;
  const DETAIL_LINES = 3;
  const listHeight = () => Math.max(1, rows() - 2 - DETAIL_LINES);
  const selected = (): Voice | undefined => view[cursor];

  function refilter(keep: Voice | undefined): void {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    view = searchable
      .filter(
        ({ voice, haystack }) =>
          (!pickedOnly || picks.has(voice.name)) && terms.every((term) => haystack.includes(term)),
      )
      .map(({ voice }) => voice);
    const kept = keep === undefined ? -1 : view.indexOf(keep);
    cursor = kept >= 0 ? kept : 0;
    top = 0;
  }

  function stop(): void {
    const current = playing;
    playing = undefined;
    current?.child.kill("SIGTERM");
  }

  function play(voice: Voice): void {
    stop();
    const child = spawn("afplay", [voice.file], { stdio: "ignore" });
    playing = { voice, child };
    child.on("error", (error) => {
      if (playing?.child === child) playing = undefined;
      status = `afplay failed: ${error.message}`;
      render();
    });
    child.on("exit", () => {
      if (playing?.child === child) {
        playing = undefined;
        render();
      }
    });
  }

  function togglePick(voice: Voice): void {
    if (picks.has(voice.name)) picks.delete(voice.name);
    else
      picks.set(voice.name, {
        name: voice.name,
        speaker: voice.speaker,
        text: voice.text,
      });
    savePicks(picks);
  }

  function moveTo(next: number): void {
    cursor = Math.max(0, Math.min(view.length - 1, next));
  }

  // -- drawing ---------------------------------------------------------------

  function headerLine(width: number): string {
    const parts = [
      "Jak 1 voice lines",
      `${catalog.length} clips`,
      `${picks.size} picked`,
      filter === "" ? "no filter" : `filter "${filter}"`,
      `${view.length} shown`,
    ];
    if (pickedOnly) parts.push("picked only");
    return `${BOLD}${fit(parts.join("  |  "), width)}${RESET}`;
  }

  function rowLine(voice: Voice, isCursor: boolean, width: number, nameWidth: number): string {
    const isPicked = picks.has(voice.name);
    const isPlaying = playing?.voice === voice;
    const mark = isPicked ? "[x]" : "[ ]";
    const playMark = isPlaying ? ">" : " ";
    const name = fit(voice.name, nameWidth);
    const seconds = `${voice.seconds.toFixed(1)}s`.padStart(6);
    const speaker = fit(voice.speaker, 20);
    const text = fit(
      voice.text,
      Math.max(0, width - (3 + 1 + 1 + 1 + nameWidth + 1 + 6 + 1 + 20 + 1)),
    );
    const plain = `${mark} ${playMark} ${name} ${seconds} ${speaker} ${text}`;
    if (isCursor) return `${REVERSE}${fit(plain, width)}${RESET}`;
    const styledMark = isPicked ? `${GREEN}${mark}${RESET}` : mark;
    const styledPlay = isPlaying ? `${YELLOW}${playMark}${RESET}` : playMark;
    const body = `${name} ${DIM}${seconds}${RESET} ${CYAN}${speaker}${RESET} ${text}`;
    return `${styledMark} ${styledPlay} ${body}`;
  }

  function detailLines(width: number): string[] {
    const voice = selected();
    if (voice === undefined) return [fit("no clip matches", width), "", ""];
    const origin = voice.source === "none" ? "no subtitle" : voice.scene || "hint";
    const flags = `${picks.has(voice.name) ? " PICKED" : ""}${playing?.voice === voice ? " PLAYING" : ""}`;
    const title = `${voice.name}  ${voice.seconds.toFixed(1)}s  ${origin}${flags}`;
    const body = `${voice.speaker === "" ? "" : `${voice.speaker}: `}${voice.text}`;
    return [
      `${BOLD}${fit(title, width)}${RESET}`,
      fit(body.slice(0, width), width),
      fit(body.slice(width, width * 2), width),
    ];
  }

  function footerLine(width: number): string {
    if (typing) return fit(`/${filter}_   Enter applies   Esc clears`, width);
    if (status !== "") return `${YELLOW}${fit(status, width)}${RESET}`;
    const keys =
      "j/k move  C-d/C-u page  gg/G ends  / filter  l/Enter play  s/h stop  space pick  p picked only  q quit";
    return `${DIM}${fit(keys, width)}${RESET}`;
  }

  function render(): void {
    const width = columns();
    const height = listHeight();
    if (cursor < top) top = cursor;
    if (cursor >= top + height) top = cursor - height + 1;
    const nameWidth = Math.min(
      12,
      Math.max(8, ...view.slice(top, top + height).map((voice) => voice.name.length)),
    );
    const lines = [headerLine(width)];
    for (let row = 0; row < height; row += 1) {
      const voice = view[top + row];
      lines.push(voice === undefined ? "" : rowLine(voice, top + row === cursor, width, nameWidth));
    }
    lines.push(...detailLines(width), footerLine(width));
    process.stdout.write(`${ESC}[H${lines.map((line) => `${line}${ESC}[K`).join("\r\n")}${ESC}[J`);
  }

  // -- keys ------------------------------------------------------------------

  function typeFilterKey(key: string): void {
    const before = selected();
    if (key === "ctrl-c") quit();
    else if (key === "enter") typing = false;
    else if (key === "escape") {
      filter = "";
      typing = false;
      refilter(before);
    } else if (key === "backspace") {
      if (filter === "") typing = false;
      filter = filter.slice(0, -1);
      refilter(before);
    } else if ([...key].length === 1 && key >= " ") {
      filter += key;
      refilter(undefined);
    }
  }

  function normalKey(key: string): void {
    const voice = selected();
    const page = Math.max(1, Math.floor(listHeight() / 2));
    const wasG = pendingG;
    pendingG = false;
    switch (key) {
      case "j":
      case "down":
        moveTo(cursor + 1);
        break;
      case "k":
      case "up":
        moveTo(cursor - 1);
        break;
      case "ctrl-d":
      case "pagedown":
        moveTo(cursor + page);
        break;
      case "ctrl-u":
      case "pageup":
        moveTo(cursor - page);
        break;
      case "g":
        if (wasG) moveTo(0);
        else pendingG = true;
        break;
      case "home":
        moveTo(0);
        break;
      case "G":
      case "end":
        moveTo(view.length - 1);
        break;
      case "/":
        typing = true;
        break;
      case "escape":
        if (filter !== "") {
          filter = "";
          refilter(voice);
        }
        break;
      case "l":
      case "enter":
        if (voice !== undefined) play(voice);
        break;
      case "s":
      case "h":
        stop();
        break;
      case " ":
        if (voice !== undefined) {
          togglePick(voice);
          if (pickedOnly) refilter(voice);
        }
        break;
      case "p":
        pickedOnly = !pickedOnly;
        refilter(voice);
        break;
      case "q":
      case "ctrl-c":
        quit();
        break;
      default:
        break;
    }
  }

  function onKey(key: string): void {
    status = "";
    if (typing) typeFilterKey(key);
    else normalKey(key);
  }

  // -- lifecycle -------------------------------------------------------------

  let restored = false;
  function restoreTerminal(): void {
    if (restored) return;
    restored = true;
    stop();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(LEAVE_SCREEN);
  }

  function quit(): never {
    restoreTerminal();
    process.exit(0);
  }

  process.on("exit", restoreTerminal);
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const key of decodeKeys(chunk)) onKey(key);
    render();
  });
  process.stdout.on("resize", render);
  process.stdout.write(ENTER_SCREEN);
  refilter(undefined);
  render();
}

main();
