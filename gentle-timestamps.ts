/**
 * Gentle Timestamps — a timestamp in the top-right corner of every chat message box,
 * configurable live with /gentle:timestamps.
 *
 * - Settings apply immediately. Pickers preview live: Esc restores, Enter saves.
 * - Preferences live in the Gentle Shell config home (see configPath()).
 * - The render patch is a thin permanent shim that calls the logic of the most
 *   recently evaluated module, so /reload picks up code changes without a restart.
 * - Built for long sessions: per-component memos, an incremental tool-call index
 *   and no per-frame copies of the session.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `relative`, `relative-time`, `smart` and `smart-numeric` are pseudo-formats; every other value is strftime. */
export const RELATIVE = "relative";
export const RELATIVE_TIME = "relative-time";
/** Pseudo-format that adds only as much date as the message's age needs; the time is always there. */
export const SMART = "smart";
/** Smart with numeric dates: "16/11 14:32" instead of "16 Nov 14:32". */
export const SMART_NUMERIC = "smart-numeric";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
// Calendar-day difference in UTC, so a DST shift cannot move %j by one.
const dayOfYear = (d: Date) =>
	(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86_400_000 + 1;

// Tokens are computed lazily: a format only pays for the tokens it uses.
const TOKENS: Record<string, (d: Date) => string> = {
	"%": () => "%",
	a: (d) => WEEKDAYS[d.getDay()].slice(0, 3),
	A: (d) => WEEKDAYS[d.getDay()],
	b: (d) => MONTHS[d.getMonth()].slice(0, 3),
	B: (d) => MONTHS[d.getMonth()],
	d: (d) => pad(d.getDate()),
	e: (d) => String(d.getDate()).padStart(2, " "),
	F: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
	H: (d) => pad(d.getHours()),
	I: (d) => pad(d.getHours() % 12 || 12),
	j: (d) => pad(dayOfYear(d), 3),
	M: (d) => pad(d.getMinutes()),
	m: (d) => pad(d.getMonth() + 1),
	p: (d) => (d.getHours() < 12 ? "AM" : "PM"),
	R: (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`,
	S: (d) => pad(d.getSeconds()),
	T: (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
	Y: (d) => String(d.getFullYear()),
	y: (d) => pad(d.getFullYear() % 100),
};

/**
 * strftime(3) subset: %aAbBdeFHIjMmpRSTYy and %%, English names. A `-` flag drops the
 * padding (`%-I` -> "2", GNU style). Unknown tokens are left as written, so a typo
 * shows up in the corner instead of vanishing.
 */
export const strftime = (d: Date, format: string): string =>
	format.replace(/%(-?)(.)/g, (whole, flag: string, c: string) => {
		const value = TOKENS[c]?.(d);
		if (value === undefined) return whole;
		return flag ? value.replace(/^[0 ]+(?=\d)/, "") : value;
	});

/** "now" under a minute, then "3 min ago", "2 h ago"…, always floored so an age never reads older than it is. */
export function relativeStamp(ms: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - ms) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days} d ago`;
	if (days < 30) return `${Math.floor(days / 7)} w ago`;
	if (days < 365) return `${Math.min(11, Math.floor(days / 30))} mo ago`;
	return `${Math.floor(days / 365)} y ago`;
}

/**
 * When relativeStamp()'s text next changes: the next whole minute, hour or day of age (weeks,
 * months and years all turn on a day). A painted relative stamp stays valid until then.
 */
export function nextRelativeChange(ms: number, now = Date.now()): number {
	const age = Math.max(0, now - ms);
	const unit = age < 3_600_000 ? 60_000 : age < 86_400_000 ? 3_600_000 : 86_400_000;
	return ms + (Math.floor(age / unit) + 1) * unit;
}

export const isRelative = (format: string | null): boolean => format === RELATIVE || format === RELATIVE_TIME;

const startOfDay = (ms: number) => {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * The time is always shown; only the date grows with the age: "14:32" today, "16 Nov 14:32"
 * this year, "16 Nov 2025 14:32" another year (`numeric`: "16/11 14:32", "16/11/25 14:32").
 * No age ever drops the time, so an old session reads like a recent one. "Yesterday" and
 * weekdays are left out on purpose: a date is shorter and reads without mapping back to one.
 */
export function smartStamp(ms: number, now = Date.now(), numeric = false): string {
	const today = startOfDay(now);
	const d = new Date(ms);
	if (ms >= today) return strftime(d, "%H:%M");
	if (d.getFullYear() === new Date(now).getFullYear()) return strftime(d, numeric ? "%d/%m %H:%M" : "%-d %b %H:%M");
	return strftime(d, numeric ? "%d/%m/%y %H:%M" : "%-d %b %Y %H:%M");
}

export function formatStamp(ms: number, format: string, now = Date.now()): string {
	if (format === "") return "";
	if (format === SMART) return smartStamp(ms, now);
	if (format === SMART_NUMERIC) return smartStamp(ms, now, true);
	if (format === RELATIVE) return relativeStamp(ms, now);
	if (format === RELATIVE_TIME) return `${strftime(new Date(ms), "%H:%M")} · ${relativeStamp(ms, now)}`;
	return strftime(new Date(ms), format);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const SCHEMA = "gentle-timestamps/v1";

export interface TimestampsConfig {
	/** false restores Pi's untouched render. */
	enabled: boolean;
	/** strftime format for today's messages, a pseudo-format (`relative`, `smart`…), or "" for no stamp. */
	format: string;
	/** Format for messages from earlier days; null means "use `format` for every age". */
	formatOlder: string | null;
	/**
	 * "plain" (Minimal): bare text toned from the box background. "accent": the theme's accent color.
	 * "block" (Badge): a sidebar-card chip (panel surface framed by thin ▏ ▕ bars, muted text).
	 */
	style: "plain" | "accent" | "block";
}

export const DEFAULTS: TimestampsConfig = {
	enabled: true,
	format: "%H:%M",
	formatOlder: SMART_NUMERIC,
	style: "plain",
};

export const STYLES: { label: string; value: TimestampsConfig["style"] }[] = [
	{ label: "Minimal", value: "plain" },
	{ label: "Accent", value: "accent" },
	{ label: "Badge", value: "block" },
];

// Today's menu, from least to most information: clocks, then time since, then the
// date-bearing shapes (least useful today, since the date is always today's).
// Distinct clock shapes only. Rarer ones (seconds…) stay reachable via
// Custom… or `/gentle:timestamps <format>`, and hiding stamps is the main menu's on/off
// toggle, not a preset nor an empty Custom… answer.
/** A menu choice; `help` is the line shown under the list while the cursor is on it. */
export interface Preset {
	label: string;
	format: string;
	help: string;
}

const RELATIVE_HELP = "Time since, rounded down: now, 5 min, 2 h, 3 d, 2 w, 3 mo, 1 y ago";
const DATE_TIME_HELP = "Day/month and time: 16/11 14:32";
const ISO_HELP = "Year-month-day and time: 2026-11-16 14:32";
// Help rows must fit 80 columns: keep these short.
const CUSTOM_EXAMPLES = "%H:%M → 14:32 · %-I:%M %p → 2:32 PM · %d/%m → 16/11 · %b → Nov";

export const PRESETS: Preset[] = [
	{ label: "Time", format: "%H:%M", help: "24-hour clock: 14:32" },
	{ label: "12-hour", format: "%-I:%M %p", help: "12-hour clock: 2:32 PM" },
	{ label: "Time + relative", format: RELATIVE_TIME, help: "Clock and time since: 14:32 · 5 min ago" },
	{ label: "Relative", format: RELATIVE, help: RELATIVE_HELP },
	{ label: "Date + time", format: "%d/%m %H:%M", help: DATE_TIME_HELP },
	{ label: "ISO date + time", format: "%Y-%m-%d %H:%M", help: ISO_HELP },
];

// Earlier days need the date, so shapes without one (Time, Time + relative) are left out.
export const OLDER_PRESETS: Preset[] = [
	{ label: "Smart", format: SMART, help: "14:32 today · 16 Nov 14:32 this year · 16 Nov 2025 14:32 before" },
	{ label: "Smart numeric", format: SMART_NUMERIC, help: "14:32 today · 16/11 14:32 this year · 16/11/25 14:32 before" },
	{ label: "Date + time", format: "%d/%m %H:%M", help: DATE_TIME_HELP },
	{ label: "ISO date + time", format: "%Y-%m-%d %H:%M", help: ISO_HELP },
	{ label: "Relative", format: RELATIVE, help: RELATIVE_HELP },
];


// The stamp is written straight to the terminal, so no format may carry C0, DEL
// or C1: a stray escape here could spoof the display or rewrite the clipboard.
const sanitize = (s: string) => s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();

/** Preference file, overridable for tests and for a non-default Gentle Shell home. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
	if (env.GENTLE_TIMESTAMPS_CONFIG) return env.GENTLE_TIMESTAMPS_CONFIG;
	const home = env.GENTLE_PI_CONFIG_HOME || join(homedir(), ".gentle-shell", "gentle-ai");
	return join(home, "timestamps.json");
}

/** Tolerant by design: each key falls back on its own; unknown keys (e.g. a legacy `locale`) are dropped. */
export function parseConfig(raw: unknown): TimestampsConfig {
	const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULTS.enabled,
		format: typeof input.format === "string" ? sanitize(input.format) : DEFAULTS.format,
		formatOlder:
			input.formatOlder === null
				? null
				: typeof input.formatOlder === "string"
					? sanitize(input.formatOlder)
					: DEFAULTS.formatOlder,
		style: STYLES.some((s) => s.value === input.style) ? (input.style as TimestampsConfig["style"]) : DEFAULTS.style,
	};
}

export function readConfig(path = configPath()): TimestampsConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULTS }; // absent, unreadable or malformed
	}
}

/** Windows antivirus/indexers briefly lock files; a short retry keeps saves from failing spuriously. */
function renameWithRetry(from: string, to: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code ?? "";
			if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
		}
	}
}

/** Atomic write (temp file + rename): a half-written file would read back as defaults. */
export function writeConfig(config: TimestampsConfig, path = configPath()): void {
	const { enabled, format, formatOlder, style } = config;
	const body = JSON.stringify({ schema: SCHEMA, enabled, format, formatOlder, style }, null, "\t") + "\n";
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.timestamps.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmp, body, { mode: 0o600 });
	try {
		renameWithRetry(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw error;
	}
}

/** gentle-when's settings file, the extension's former name; read once to migrate, never modified. */
const LEGACY_CONFIG = "when.json";

/**
 * Upgrading from gentle-when: when the default timestamps.json is missing and the legacy
 * when.json sits in the same folder, its validated content becomes timestamps.json. An explicit
 * GENTLE_TIMESTAMPS_CONFIG disables it. Malformed or unreadable legacy files migrate nothing;
 * no failure ever throws.
 */
export function migrateLegacyConfig(env: Record<string, string | undefined> = process.env): void {
	try {
		if (env.GENTLE_TIMESTAMPS_CONFIG) return;
		const target = configPath(env);
		if (existsSync(target)) return;
		const legacy = join(dirname(target), LEGACY_CONFIG);
		if (!existsSync(legacy)) return;
		writeConfig(parseConfig(JSON.parse(readFileSync(legacy, "utf8"))), target);
	} catch {
		// defaults apply
	}
}

// ---------------------------------------------------------------------------
// Process-global state
// ---------------------------------------------------------------------------

/** What the render patch remembers per component, so steady frames cost a few string comparisons. */
interface Memo {
	/** Resolved message time; only stored once known, so a guess is never frozen. */
	time?: number;
	version: number;
	width: number;
	l0: string | undefined;
	l1: string | undefined;
	theme: unknown;
	/** Date.now() from which the painted row must be recomputed (a relative age's next change, unresolved times). */
	expires: number;
	index: number;
	row: string | undefined;
	/** When the box was first seen without a resolved time. */
	since?: number;
	/** Already added to the canary's counts, as resolved or as broken. */
	counted?: boolean;
}

type BoxKind = "user" | "assistant" | "tool";

interface SessionLike {
	getEntries?: () => unknown[];
	getEntryCount?: () => number;
	getEntry?: (id: string) => unknown;
}

interface State {
	patched: boolean;
	config: TimestampsConfig;
	/** Bumped whenever painted stamps may change (config, preview, day rollover, session). */
	version: number;
	checkedAt: number;
	fileMtime: number;
	/** A session-only change whose save failed; the file must not silently override it. */
	unsaved: boolean;
	dayStart: number;
	dayEnd: number;
	memos: WeakMap<object, Memo>;
	session: (() => SessionLike | undefined) | undefined;
	toolTimes: Map<string, number>;
	/** Exact user-message text -> its times in session order, for boxes Pi creates without ids (live sends). */
	userTimes: Map<string, number[]>;
	/** User-message times already shown by a box, so repeated texts each get their own time. */
	claimedUser: Set<number>;
	indexedLength: number;
	indexedCount: number;
	indexedAt: number;
	ui:
		| {
				setStatus?: (key: string, text: string | undefined) => void;
				notify?: (message: string, type?: "info" | "warning" | "error") => void;
		  }
		| undefined;
	/** Canary counts per box kind for this session: times that resolved and boxes whose fields could not be read. */
	health: Record<BoxKind, { resolved: number; broken: number }>;
	/** The canary warned already; one warning per process. */
	warned: boolean;
	timer: ReturnType<typeof setInterval> | undefined;
	/** The render logic of the latest module evaluation; the permanent shim calls through it. */
	decorate: ((component: object, lines: string[], width: number) => string[]) | undefined;
}

// Pi evaluates extensions with jiti (no module cache) and /reload re-evaluates
// this file while prototype patches survive. One state object per process keeps
// the shim, the command and the timers in agreement across evaluations; missing
// fields are filled in so a newer evaluation can extend an older state.
const newHealth = (): State["health"] => ({
	user: { resolved: 0, broken: 0 },
	assistant: { resolved: 0, broken: 0 },
	tool: { resolved: 0, broken: 0 },
});
const STATE_KEY = Symbol.for("gentle-timestamps.v1");
const state = (((globalThis as any)[STATE_KEY] ??= {}) as State);
state.patched ??= false;
state.config ??= { ...DEFAULTS };
state.version ??= 0;
state.checkedAt ??= 0;
state.fileMtime ??= 0;
state.unsaved ??= false;
state.dayStart ??= 0;
state.dayEnd ??= 0;
state.memos ??= new WeakMap();
state.toolTimes ??= new Map();
state.userTimes ??= new Map();
state.claimedUser ??= new Set();
state.indexedLength ??= 0;
state.indexedCount ??= -1;
state.indexedAt ??= 0;
state.health = newHealth(); // unconditional: a hot reload never keeps an older shape
state.warned ??= false;

// A process that ran gentle-when (the former name) keeps its render shim, which calls this
// legacy state's decorate. Clearing it makes the old shim pass lines through: one stamp, not two.
const legacyState = (globalThis as any)[Symbol.for("gentle-when.v2")] as Partial<State> | undefined;
if (legacyState && typeof legacyState === "object") {
	legacyState.decorate = undefined;
	if (legacyState.timer) clearInterval(legacyState.timer);
	legacyState.timer = undefined;
}

migrateLegacyConfig();

const sameConfig = (a: TimestampsConfig, b: TimestampsConfig) =>
	a.enabled === b.enabled && a.format === b.format && a.formatOlder === b.formatOlder && a.style === b.style;

function setConfig(next: TimestampsConfig): void {
	if (!sameConfig(next, state.config)) state.version++;
	state.config = next;
}

/**
 * Re-read the file when it changed. Throttled to once every 2s for render calls;
 * `force` skips the throttle so a command never acts on a stale snapshot.
 */
function refreshConfig(force = false): TimestampsConfig {
	const now = Date.now();
	if (!force && now - state.checkedAt < 2000) return state.config;
	state.checkedAt = now;
	let mtime: number;
	try {
		mtime = statSync(configPath()).mtimeMs;
	} catch {
		return state.config; // absent or unreachable: keep what is showing
	}
	if (mtime === state.fileMtime && (!force || state.unsaved)) return state.config;
	state.fileMtime = mtime;
	state.unsaved = false;
	setConfig(readConfig());
	return state.config;
}

/** Forced re-read for commands and tests. */
export function syncConfig(): TimestampsConfig {
	return refreshConfig(true);
}

/** Tentative config while a picker previews: paints immediately, never touches the file. */
export function showPreview(config: TimestampsConfig): void {
	setConfig(config);
}

// ---------------------------------------------------------------------------
// Message times
// ---------------------------------------------------------------------------

const safely = <T>(read: () => T): T | undefined => {
	try {
		return read();
	} catch {
		return undefined;
	}
};
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const parseIso = (v: unknown): number | undefined => {
	if (typeof v !== "string") return undefined;
	const t = Date.parse(v);
	return Number.isNaN(t) ? undefined : t;
};
/** Message time in ms; older or foreign sessions may only carry the entry's ISO timestamp. */
const entryTime = (entry: any): number | undefined => finite(entry?.message?.timestamp) ?? parseIso(entry?.timestamp);

/** The text Pi shows in a user box: the message's text blocks joined, images dropped. */
const messageText = (message: any): string | undefined => {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("");
};

function rememberUser(text: string | undefined, time: number | undefined): void {
	if (!text || time === undefined) return;
	const times = state.userTimes.get(text);
	if (!times) state.userTimes.set(text, [time]);
	else if (!times.includes(time)) times.push(time);
}

function indexEntry(entry: any): void {
	const message = entry?.message;
	if (entry?.type !== "message" || !message) return;
	const time = entryTime(entry);
	if (time === undefined) return;
	if (message.role === "user") return rememberUser(messageText(message), time);
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const part of message.content) {
		if (part?.type === "toolCall" && typeof part.id === "string") state.toolTimes.set(part.id, time);
	}
}

/**
 * Index the session's new entries. getEntries() copies the whole session, so it
 * only runs when the entry count changed (an O(1) check), and only the new tail
 * is indexed. Returns whether anything new was read.
 */
function refreshIndex(): boolean {
	const session = safely(() => state.session?.());
	if (!session) return false;
	const count = safely(() => session.getEntryCount?.());
	if (typeof count === "number") {
		if (count === state.indexedCount) return false;
	} else {
		const now = Date.now();
		if (now - state.indexedAt < 2000) return false;
		state.indexedAt = now;
	}
	const entries = safely(() => session.getEntries?.());
	if (!Array.isArray(entries)) return false;
	const from = state.indexedLength <= entries.length ? state.indexedLength : 0;
	for (let i = from; i < entries.length; i++) indexEntry(entries[i]);
	state.indexedLength = entries.length;
	state.indexedCount = typeof count === "number" ? count : -1;
	return true;
}

/** Time of the assistant message that issued a tool call. */
function toolTime(id: unknown): number | undefined {
	if (typeof id !== "string") return undefined;
	const known = state.toolTimes.get(id);
	if (known !== undefined || !refreshIndex()) return known;
	return state.toolTimes.get(id);
}

/** Oldest not-yet-shown time of a user message with exactly this text (never a substring match). */
function userTimeByText(text: string): number | undefined {
	const pick = () => {
		for (const time of state.userTimes.get(text) ?? []) {
			if (!state.claimedUser.has(time)) {
				state.claimedUser.add(time);
				return time;
			}
		}
		return undefined;
	};
	return pick() ?? (refreshIndex() ? pick() : undefined);
}

/**
 * The fields read from Pi's components. Pi declares them `private`, so they are read through this
 * local shape; test/contract/pi.contract.mjs checks that the real components still carry them.
 */
interface BoxFields {
	text?: unknown;
	messageId?: unknown;
	timestamp?: unknown;
	toolCallId?: unknown;
	lastMessage?: { timestamp?: unknown };
}

/** Resolved time, or undefined when not (yet) known so the caller never caches a guess. */
function resolveTime(component: object): number | undefined {
	const c = component as BoxFields;
	if (component instanceof UserMessageComponent) {
		// Rebuilt chats carry the entry id and time; a box created live on send only has its text.
		const id = c.messageId;
		let time = typeof id === "string" ? entryTime(safely(() => state.session?.()?.getEntry?.(id))) : undefined;
		time ??= parseIso(c.timestamp) ?? finite(c.timestamp);
		if (time !== undefined) {
			state.claimedUser.add(time); // a later live box with the same text must not take this time
			return time;
		}
		return typeof c.text === "string" && c.text !== "" ? userTimeByText(c.text) : undefined;
	}
	if (component instanceof ToolExecutionComponent) return toolTime(c.toolCallId);
	if (component instanceof AssistantMessageComponent) return finite(c.lastMessage?.timestamp) ?? parseIso(c.timestamp);
	return undefined;
}

// Message times come from private fields of Pi's components. If Pi renames one, stamps would
// silently vanish (user, tool) or show the current time forever (assistant, tool). The canary
// counts boxes whose fields are missing. A time that is merely unknown is not evidence: a tool
// call may stream for minutes before its message is saved, and a user box may never match a
// saved text (skill sends). Only assistant boxes, which have no always-present field to check,
// are judged by time, and one resolved assistant box clears them.
const CANARY_GRACE_MS = 60_000; // a live assistant box may legitimately wait this long for its message
const CANARY_THRESHOLD = 3;
const CANARY_WARNING = "gentle-timestamps: could not read message times (Pi may have changed)";

const kindOf = (c: object): BoxKind | undefined =>
	c instanceof UserMessageComponent
		? "user"
		: c instanceof ToolExecutionComponent
			? "tool"
			: c instanceof AssistantMessageComponent
				? "assistant"
				: undefined;

/** Counts each box once, as resolved or as broken (its fields are unreadable), and warns once per process. */
function observe(component: object, memo: Memo, resolved: boolean, now: number): void {
	if (memo.counted) return;
	const kind = kindOf(component);
	if (!kind) return;
	const health = state.health[kind];
	if (resolved) {
		memo.counted = true;
		health.resolved++;
		return;
	}
	const fields = component as BoxFields;
	let broken: boolean;
	if (kind === "user") broken = typeof fields.text !== "string";
	else if (kind === "tool") broken = typeof fields.toolCallId !== "string";
	else {
		memo.since ??= now;
		broken = now - memo.since >= CANARY_GRACE_MS;
	}
	if (!broken) return; // not counted: the box may resolve later and then counts as resolved
	memo.counted = true;
	health.broken++;
	if (state.warned || health.broken < CANARY_THRESHOLD) return;
	if (kind === "assistant" && health.resolved !== 0) return;
	state.warned = true;
	safely(() => state.ui?.notify?.(CANARY_WARNING, "warning"));
}

/** Keeps "today" bounds current; crossing midnight bumps the version so today's stamps repaint as older ones. */
function rollDay(now: number): void {
	if (now >= state.dayStart && now < state.dayEnd) return;
	const d = new Date(now);
	state.dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	state.dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
	state.version++;
}

const formatFor = (ms: number): string => {
	const { format, formatOlder } = state.config;
	return ms >= state.dayStart || formatOlder === null ? format : formatOlder;
};

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

const STAMP_DELTA = 60; // brightness offset of the stamp text from the box bg (darker on light bgs)
const STAMP_NO_BG = 100; // gray level (0-255) for bg-less lines on truecolor terminals (assistant)
// Badge chip: the live Pi theme's sidebar tokens (customMessageBg surface, muted text),
// following /settings theme switches. These constants are only the fallback when no
// theme instance is reachable or it rejects a token.
const FALLBACK_CHIP_BG = "\x1b[48;2;16;10;15m"; // #100A0F, Gentleman themes' bgSubtle
const FALLBACK_CHIP_FG = "\x1b[38;2;167;142;155m"; // #A78E9B, their muted role
const FALLBACK_CHIP_BAR = "\x1b[38;2;92;48;68m"; // a muted rose, close to their card border
const FALLBACK_ACCENT = "\x1b[36m"; // cyan: readable on any palette when no theme is reachable
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const OSC133_START = "\x1b]133;A\x07";
// CSI, OSC (BEL or ST terminated) and single-char ESC sequences: enough to test "is this line blank".
const TERMINAL_SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const BG_SGR = /\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/; // truecolor or 256-color background

interface ThemeLike {
	colors?: Record<string, unknown>;
	getBgAnsi?: (token: string) => string;
	getFgAnsi?: (token: string) => string;
}

const currentTheme = (): ThemeLike | undefined => {
	const theme = (globalThis as any)[THEME_KEY];
	return theme && typeof theme === "object" ? theme : undefined;
};

/** A theme token's SGR opener, or undefined when the theme lacks it (tokenAnsi throws on unknown tokens). */
function themeAnsi(theme: ThemeLike | undefined, token: string, kind: "fg" | "bg"): string | undefined {
	if (!theme?.colors?.[token]) return undefined;
	const ansi = safely(() => (kind === "fg" ? theme.getFgAnsi?.(token) : theme.getBgAnsi?.(token)));
	return typeof ansi === "string" && ansi !== "" ? ansi : undefined;
}

/** The sidebar card look: panel surface, thin border-colored bars on both sides and muted text (lib/shell-card.ts). */
function chipColors(theme: ThemeLike | undefined): { bg: string; fg: string; bar: string } {
	return {
		bg: themeAnsi(theme, "customMessageBg", "bg") ?? FALLBACK_CHIP_BG,
		fg: themeAnsi(theme, "muted", "fg") ?? FALLBACK_CHIP_FG,
		bar: themeAnsi(theme, "border", "fg") ?? FALLBACK_CHIP_BAR,
	};
}

const isBlank = (line: string | undefined) =>
	typeof line === "string" && line.replace(TERMINAL_SEQUENCES, "").trim() === "";
const hasBg = (line: string | undefined) => typeof line === "string" && BG_SGR.test(line);

/** The box's top padding line (blank with a bg) at 0 or 1 (tools start with a spacer), else a blank line 0. Never content. */
function targetLine(lines: string[]): number {
	if (isBlank(lines[0]) && hasBg(lines[0])) return 0;
	if (isBlank(lines[0]) && isBlank(lines[1]) && hasBg(lines[1])) return 1;
	if (isBlank(lines[0])) return 0;
	return -1;
}

/** The padding line rewritten with the stamp at its right edge, or undefined when it does not fit. */
function paint(line: string, stamp: string, width: number, style: TimestampsConfig["style"], theme: ThemeLike | undefined): string | undefined {
	if (stamp === "") return undefined;
	const block = style === "block";
	const content = block ? `▏${stamp}▕` : stamp;
	const columns = visibleWidth(content);
	if (width < columns + (block ? 0 : 1)) return undefined;
	// Reuse the line's own background (tools swap box bg on completion, so component fields lie).
	const bgCode = line.match(BG_SGR)?.[0];
	const base = bgCode?.match(/48;2;(\d+);(\d+);(\d+)/)?.slice(1, 4).map(Number);
	const rgb = (channels: number[]) => `\x1b[38;2;${channels.map((c) => Math.min(255, Math.max(0, c))).join(";")}m`;
	const prefix = line.startsWith(OSC133_START) ? OSC133_START : "";
	let row: string;
	if (block) {
		const chip = chipColors(theme);
		const lead = " ".repeat(width - columns);
		// Thin bars frame the chip: ▏ hugs the left edge of its cell and ▕ the right one, so the chip
		// surface starts and ends exactly at the bars and both sit the same distance from the stamp.
		row = `${bgCode ?? ""}${lead}\x1b[49m${chip.bg}${chip.bar}▏${chip.fg}${stamp}${chip.bar}▕\x1b[39;22m\x1b[49m`;
	} else {
		// Text color: accent from the theme; otherwise the bg nudged toward contrast on truecolor,
		// dim on 256-color, a fixed gray without bg.
		let fg: string;
		if (style === "accent") fg = themeAnsi(theme, "accent", "fg") ?? FALLBACK_ACCENT;
		else if (base) {
			const delta = base.reduce((a, b) => a + b, 0) / 3 > 128 ? -STAMP_DELTA : STAMP_DELTA;
			fg = rgb(base.map((c) => c + delta));
		} else if (bgCode) fg = "\x1b[2m";
		else fg = rgb([STAMP_NO_BG, STAMP_NO_BG, STAMP_NO_BG]);
		const body = " ".repeat(width - columns - 1) + `${fg}${stamp}\x1b[39;22m `;
		row = bgCode ? `${bgCode}${body}\x1b[49m` : body;
	}
	row = prefix + row;
	// Pi stops the TUI on a line wider than the terminal; never be the one to hand it one.
	return visibleWidth(row) <= width ? row : undefined;
}

const withRow = (lines: string[], index: number, row: string) => {
	const out = lines.slice();
	out[index] = row;
	return out;
};

/** Called for every chat component on every frame; the memo keeps steady frames to a few comparisons. */
function decorate(component: object, lines: string[], width: number): string[] {
	const config = refreshConfig();
	if (!config.enabled || !Array.isArray(lines) || lines.length === 0) return lines;
	const now = Date.now();
	rollDay(now);
	const theme = config.style === "block" || config.style === "accent" ? currentTheme() : undefined;
	const memo = state.memos.get(component);
	if (
		memo &&
		memo.version === state.version &&
		memo.width === width &&
		memo.l0 === lines[0] &&
		memo.l1 === lines[1] &&
		memo.theme === theme &&
		now < memo.expires
	) {
		return memo.row === undefined ? lines : withRow(lines, memo.index, memo.row);
	}

	const next: Memo = memo ?? ({} as Memo);
	const index = targetLine(lines);
	let row: string | undefined;
	let expires = Number.POSITIVE_INFINITY;
	if (index >= 0) {
		if (next.time === undefined) next.time = resolveTime(component);
		let time = next.time;
		observe(component, next, time !== undefined, now);
		if (time === undefined) {
			// A user message is only stamped with its real time; live assistant/tool boxes may show "now"
			// until their entry is saved. Either way, retry soon instead of caching.
			expires = now + 500;
			if (!(component instanceof UserMessageComponent)) time = now;
		}
		if (time !== undefined) {
			const format = formatFor(time);
			if (isRelative(format)) expires = Math.min(expires, nextRelativeChange(time, now));
			row = paint(lines[index], formatStamp(time, format, now), width, config.style, theme);
		}
	}
	Object.assign(next, { version: state.version, width, l0: lines[0], l1: lines[1], theme, expires, index, row });
	state.memos.set(component, next);
	return row === undefined ? lines : withRow(lines, index, row);
}

// Every evaluation publishes its logic; only the first one installs the shim.
state.decorate = decorate;
if (!state.patched) {
	state.patched = true;
	for (const C of [UserMessageComponent, AssistantMessageComponent, ToolExecutionComponent]) {
		const original = C.prototype.render;
		C.prototype.render = function (this: object, width: number): string[] {
			const lines = original.call(this, width);
			const current = ((globalThis as any)[STATE_KEY] as State | undefined)?.decorate;
			if (!current) return lines;
			try {
				return current(this, lines, width);
			} catch {
				return lines; // a timestamp must never cost the user their chat
			}
		};
	}
}

// ---------------------------------------------------------------------------
// Idle refresh for relative ages
// ---------------------------------------------------------------------------

// Pi only paints on input or activity, so "3 min ago" would freeze while idle.
// setStatus() on an unused key asks for one frame; with the memos above, a frame
// costs little. Absolute formats never wake the TUI.
const REFRESH_MS = 30_000;
const STATUS_KEY = "gentle-timestamps";

function stopRefresh(): void {
	if (state.timer) clearInterval(state.timer);
	state.timer = undefined;
}

function startRefresh(): void {
	stopRefresh();
	const timer = setInterval(() => {
		const { enabled, format, formatOlder } = state.config;
		if (!enabled || !(isRelative(format) || isRelative(formatOlder))) return;
		safely(() => state.ui?.setStatus?.(STATUS_KEY, undefined));
	}, REFRESH_MS);
	(timer as { unref?: () => void }).unref?.();
	state.timer = timer;
}

// ---------------------------------------------------------------------------
// /gentle:timestamps
// ---------------------------------------------------------------------------

const formatLabel = (format: string): string =>
	format === "" ? "hidden" : format === RELATIVE ? "relative" : format === RELATIVE_TIME ? "time + relative"
		: format;

function describe(config: TimestampsConfig): string {
	if (!config.enabled) return "timestamps off";
	const older =
		config.formatOlder === null || config.formatOlder === config.format ? "" : `, older ${formatLabel(config.formatOlder)}`;
	const style = config.style !== "plain" ? `, style ${styleLabel(config.style)}` : "";
	return `${formatLabel(config.format)}${older}${style}`;
}

function applyConfig(next: TimestampsConfig, ctx: ExtensionCommandContext): void {
	let failure: string | undefined;
	try {
		writeConfig(next);
	} catch (error) {
		failure = (error as NodeJS.ErrnoException)?.code ?? String((error as Error)?.message ?? error);
	}
	setConfig(next);
	state.unsaved = failure !== undefined;
	state.fileMtime = safely(() => statSync(configPath()).mtimeMs) ?? 0;
	state.checkedAt = Date.now();
	if (failure === undefined) ctx.ui.notify(`gentle-timestamps: ${describe(next)}`, "info");
	else ctx.ui.notify(`gentle-timestamps: ${describe(next)} (could not save settings: ${failure}; applies to this session only)`, "warning");
}

const sample = (format: string, ms = Date.now()) => formatStamp(ms, format) || "hidden";
const TWO_DAYS = 172_800_000;

/** Cut a row to the terminal width in columns, marking the cut with an ellipsis. */
function fit(row: string, width: number): string {
	if (visibleWidth(row) <= width) return row;
	let out = "";
	for (const ch of row) {
		if (visibleWidth(out + ch) > Math.max(0, width - 1)) break;
		out += ch;
	}
	return `${out}…`;
}

const styleLabel = (style: TimestampsConfig["style"]) => STYLES.find((s) => s.value === style)?.label ?? style;
const MENU_HINT = "↑/↓ navigate · Enter select · Esc close";
// Values start one column after the longest label ("Older messages").
const settingRow = (label: string, value: string) => `${label.padEnd(14)} ${value}`;
type PickItem = { label: string; preview: TimestampsConfig | undefined; help?: string };

/**
 * Live-preview picker: moving the cursor tentatively applies the item's config,
 * so the chat's stamps repaint as you move. Items without a preview fall back to
 * the baseline. Enter returns the index with the tentative config still applied
 * (the caller persists it); Esc restores the baseline and returns undefined.
 */
async function previewPick(
	ctx: ExtensionCommandContext,
	title: string,
	items: PickItem[],
	startIndex: number,
	hint = "↑/↓ preview · Enter confirm · Esc cancel",
): Promise<number | undefined> {
	const baseline = state.config;
	const withHelp = items.some((item) => item.help);
	const result = await ctx.ui.custom<number | undefined>(
		(tui, theme, keybindings, done) => {
			let index = Math.min(Math.max(startIndex, 0), items.length - 1);
			const preview = () => showPreview(items[index].preview ?? baseline);
			preview(); // the opening frame already shows what the cursor sits on
			return {
				render(width: number): string[] {
					// Pickers whose items explain themselves keep one help row (always present, so the
					// list does not jump) between the items and the keys hint.
					const help = withHelp ? [items[index].help ?? ""] : [];
					const rows = [title, ...items.map((it, i) => `${i === index ? "●" : "○"} ${it.label}`), ...help, hint];
					return rows.map((row, i) => {
						const cut = fit(row, width);
						if (i === 0) return theme.fg("accent", cut);
						if (i >= rows.length - 1 - help.length) return theme.fg("dim", cut);
						return cut;
					});
				},
				handleInput(data: string): void {
					if (keybindings.matches(data, "tui.select.up")) index = (index - 1 + items.length) % items.length;
					else if (keybindings.matches(data, "tui.select.down")) index = (index + 1) % items.length;
					else if (keybindings.matches(data, "tui.select.confirm")) return done(index);
					else if (keybindings.matches(data, "tui.select.cancel")) return done(undefined);
					else return;
					preview();
					tui.requestRender();
				},
				invalidate() {},
			};
		},
		{ blocked: { kind: "question", message: title } },
	);
	if (result === undefined) showPreview(baseline);
	return result;
}

/** Shared picker shape: presets, a "Current" row when the value is not a preset, then Custom…. */
async function pickFormat(
	ctx: ExtensionCommandContext,
	title: string,
	head: PickItem[],
	presets: Preset[],
	current: string | null,
	headIndex: number,
	withFormat: (format: string) => TimestampsConfig,
	sampleAt: number,
	inputTitle: string,
): Promise<TimestampsConfig | undefined> {
	const items: PickItem[] = [
		...head,
		...presets.map((p) => ({
			label: `${p.label} · ${formatStamp(sampleAt, p.format)}`.trimEnd(),
			preview: withFormat(p.format),
			help: p.help,
		})),
	];
	let start = headIndex;
	if (start < 0) {
		const preset = presets.findIndex((p) => p.format === current);
		if (preset >= 0) start = head.length + preset;
		else if (current !== null) {
			const shown = current === "" ? "hidden" : `${sample(current, sampleAt)} (${current})`;
			items.push({ label: `Current · ${shown}`, preview: withFormat(current), help: `Your saved format: ${current === "" ? "hidden" : current}` });
			start = items.length - 1;
		}
	}
	items.push({ label: "Custom…", preview: undefined, help: `Type your own: ${CUSTOM_EXAMPLES}` });
	const picked = await previewPick(ctx, title, items, Math.max(0, start));
	if (picked === undefined) return undefined;
	if (picked < items.length - 1) return items[picked].preview;
	const typed = await ctx.ui.input(`${inputTitle}, e.g. ${CUSTOM_EXAMPLES}`, current || "%H:%M");
	// An empty answer cancels: hiding the stamps is the main menu's on/off toggle.
	const format = typed === undefined ? "" : sanitize(typed);
	return format === "" ? undefined : withFormat(format);
}

/**
 * Today's format changes and the older-messages format is kept. Hiding today's stamps hides
 * older ones too, and leaving that hidden pair brings the default older format back.
 */
const withTodayFormat = (config: TimestampsConfig, format: string): TimestampsConfig => ({
	...config,
	format,
	formatOlder:
		format === "" ? "" : config.format === "" && config.formatOlder === "" ? DEFAULTS.formatOlder : config.formatOlder,
});

const askFormat = (ctx: ExtensionCommandContext, config: TimestampsConfig) =>
	pickFormat(ctx, "Timestamp format", [], PRESETS, config.format, -1,
		(format) => withTodayFormat(config, format), Date.now(), "Custom format");

const askOlderFormat = (ctx: ExtensionCommandContext, config: TimestampsConfig) =>
	pickFormat(ctx, "Older messages format",
		[{ label: "Same as today", preview: { ...config, formatOlder: null }, help: "Older messages use today's format" }],
		OLDER_PRESETS, config.formatOlder, config.formatOlder === null ? 0 : -1,
		(formatOlder) => ({ ...config, formatOlder }),
		Date.now() - TWO_DAYS, "Custom format for older messages");

async function openMenu(ctx: ExtensionCommandContext): Promise<void> {
	let menuIndex = 0;
	for (;;) {
		const config = syncConfig();
		const labels = [
			settingRow("Timestamps", config.enabled ? "On" : "Off"),
			settingRow("Format", sample(config.format).replace(/^hidden$/, "Hidden")),
			settingRow("Style", styleLabel(config.style)),
			settingRow("Older messages", config.formatOlder === null
				? "Same as today"
				: sample(config.formatOlder, Date.now() - TWO_DAYS).replace(/^hidden$/, "Hidden")),
		];
		const picked = await previewPick(ctx, "Message timestamps",
			labels.map((label) => ({ label, preview: undefined })), menuIndex, MENU_HINT);
		if (picked === undefined) return;
		menuIndex = picked;
		if (picked === 0) {
			applyConfig({ ...config, enabled: !config.enabled }, ctx);
		} else if (picked === 1) {
			const next = await askFormat(ctx, config);
			if (next) applyConfig(next, ctx);
		} else if (picked === 2) {
			const items = STYLES.map((s) => ({ label: s.label, preview: { ...config, style: s.value } }));
			const pickedStyle = await previewPick(ctx, "Stamp style", items,
				Math.max(0, STYLES.findIndex((s) => s.value === config.style)));
			if (pickedStyle !== undefined) applyConfig(items[pickedStyle].preview, ctx);
		} else {
			const next = await askOlderFormat(ctx, config);
			if (next) applyConfig(next, ctx);
		}
	}
}

export default function (pi: ExtensionAPI) {
	refreshConfig(true);

	pi.on("session_start", (_event, ctx) => {
		state.session = () => ctx.sessionManager as unknown as SessionLike;
		state.toolTimes = new Map();
		state.userTimes = new Map();
		state.claimedUser = new Set();
		state.indexedLength = 0;
		state.indexedCount = -1;
		state.indexedAt = 0;
		state.health = newHealth(); // not `warned`: one warning per process
		state.version++;
		refreshConfig(true);
		if ((ctx as { hasUI?: boolean }).hasUI !== false && ctx.ui) {
			state.ui = ctx.ui as State["ui"];
			startRefresh();
		}
	});
	// A message sent live gets a text-only box; its time is known here before the entry is saved.
	pi.on("message_start", (event) => {
		const message = (event as { message?: any }).message;
		if (message?.role === "user") rememberUser(messageText(message), finite(message.timestamp));
	});
	pi.on("session_shutdown", () => {
		state.session = undefined;
		state.ui = undefined;
		stopRefresh();
	});

	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		// `/gentle:timestamps on|off|reset|<format>` skips the menu, so the setting is scriptable.
		const raw = args.trim();
		const config = syncConfig();
		if (raw === "on") return applyConfig({ ...config, enabled: true }, ctx);
		if (raw === "off") return applyConfig({ ...config, enabled: false }, ctx);
		if (raw === "reset") return applyConfig({ ...DEFAULTS }, ctx);
		// The scriptable form sets today's format; older messages keep theirs (the menu edits both).
		const format = sanitize(raw);
		if (format !== "") return applyConfig(withTodayFormat(config, format), ctx);
		await openMenu(ctx);
	};
	pi.registerCommand("gentle:timestamps", {
		description: "Message timestamps: on | off | reset | <strftime>; no argument opens the menu with live previews",
		handler,
	});
}
