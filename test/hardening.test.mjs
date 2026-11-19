// Robustness, long-session performance and correctness of the render patch and
// the /gentle:timestamps menu, exercised through the patched components, the session
// events and the command handler.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "timestamps-hardening-"));
const cfgPath = join(dir, "ext.json");
process.env.GENTLE_TIMESTAMPS_CONFIG = cfgPath;

const ext = await import("../gentle-timestamps.ts");
const pi = await import("@earendil-works/pi-coding-agent");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const BG = "\x1b[48;2;40;40;40m";
const strip = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const box = (w) => [BG + " ".repeat(w) + "\x1b[49m", " content ", BG + " ".repeat(w) + "\x1b[49m"];
const stampOf = (lines) => strip(lines[0]).trim();
const configure = (overrides = {}) => {
	ext.writeConfig({ ...ext.DEFAULTS, ...overrides });
	ext.syncConfig();
};
const iso = (ms) => new Date(ms).toISOString();

// --- session fixtures ------------------------------------------------------
const userEntry = (id, text, ms) => ({
	type: "message", id, timestamp: iso(ms), message: { role: "user", content: text, timestamp: ms },
});
const toolEntry = (id, toolIds, ms) => ({
	type: "message", id, timestamp: iso(ms),
	message: { role: "assistant", timestamp: ms, content: toolIds.map((t) => ({ type: "toolCall", id: t, name: "bash", arguments: {} })) },
});
function sessionOf(entries) {
	let reads = 0;
	return {
		reads: () => reads,
		getEntries() { reads++; return entries.slice(); },
		getEntryCount: () => entries.length,
		getEntry: (id) => entries.find((e) => e.id === id),
	};
}
function boot(sessionManager, ui = {}) {
	const handlers = {};
	let command;
	ext.default({
		on: (name, handler) => (handlers[name] ??= []).push(handler),
		registerCommand: (_name, options) => { command = options; },
	});
	for (const handler of handlers.session_start ?? []) handler({ type: "session_start" }, { sessionManager, ui, hasUI: true });
	return { handlers, command };
}
const user = (fields) => new pi.UserMessageComponent(box(40), fields);
const tool = (toolCallId) => new pi.ToolExecutionComponent(box(40), { toolCallId });

// --- robustness ------------------------------------------------------------
test("a malformed session entry never breaks the chat render", () => {
	configure({ format: "%H:%M", formatOlder: null });
	boot(sessionOf([
		{ type: "message", id: "a", timestamp: "garbage", message: { role: "user" } },
		{ type: "message", id: "b", timestamp: "garbage", message: { role: "assistant", content: "not an array" } },
		{ type: "message", id: "c" },
	]));
	for (const component of [user({ text: "hi" }), tool("t-1")]) {
		const lines = component.render(40);
		assert.equal(strip(lines[1]), " content ");
	}
});

test("a theme that throws on token lookup falls back to the built-in chip colors", () => {
	const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
	globalThis[key] = {
		colors: { customMessageBg: { r: 1, g: 2, b: 3 }, muted: { r: 4, g: 5, b: 6 } },
		getBgAnsi() { throw new Error("unknown token"); },
		getFgAnsi() { throw new Error("unknown token"); },
	};
	try {
		configure({ style: "block" });
		const lines = new pi.AssistantMessageComponent(box(40), Date.now()).render(40);
		assert.ok((lines[0].match(/48;2;/g) ?? []).length >= 2, "expected box bg + chip bg");
	} finally {
		delete globalThis[key];
	}
});

test("stamps are measured in terminal columns and never overflow the box", () => {
	configure({ format: "%H:%M 日本語", formatOlder: null });
	for (let width = 8; width <= 20; width++) {
		const lines = new pi.AssistantMessageComponent(box(width), Date.now()).render(width);
		assert.ok(visibleWidth(lines[0]) <= width, `width ${width}: ${JSON.stringify(strip(lines[0]))}`);
	}
	const wide = new pi.AssistantMessageComponent(box(20), Date.now()).render(20);
	assert.equal(visibleWidth(wide[0]), 20);
	assert.match(stampOf(wide), /日本語$/);
});

// --- long sessions -----------------------------------------------------------
test("long sessions copy the session entries once, not once per frame", () => {
	configure({ format: ext.RELATIVE, formatOlder: null });
	const now = Date.now();
	const entries = [];
	for (let i = 0; i < 100; i++) {
		entries.push(userEntry(`u${i}`, `question ${i}`, now - 60_000 * (200 - i)));
		entries.push(toolEntry(`a${i}`, [`t${i}`], now - 60_000 * (200 - i) + 1000));
	}
	const session = sessionOf(entries);
	boot(session);
	const components = [];
	for (let i = 0; i < 100; i++) {
		components.push(user({ text: `question ${i}`, messageId: `u${i}`, timestamp: iso(now - 60_000 * (200 - i)) }));
		components.push(tool(`t${i}`));
	}
	for (let frame = 0; frame < 5; frame++) for (const c of components) c.render(40);
	assert.ok(session.reads() <= 1, `getEntries() copied the session ${session.reads()} times`);
	assert.equal(stampOf(components[1].render(40)), ext.formatStamp(now - 60_000 * 200 + 1000, ext.RELATIVE, Date.now()));
});

test("a user message is stamped with its own time even when another message contains its text", () => {
	configure({ format: "%H:%M:%S", formatOlder: null });
	const t1 = new Date(2026, 0, 5, 9, 0, 0).getTime();
	const t2 = new Date(2026, 0, 5, 10, 30, 15).getTime();
	boot(sessionOf([userEntry("u1", "look at this", t1), userEntry("u2", "ok", t2)]));
	const lines = user({ text: "ok", messageId: "u2", timestamp: iso(t2) }).render(40);
	assert.equal(stampOf(lines), "10:30:15");
});

test("a live user message (text only, as Pi creates it on send) is stamped from its saved entry", () => {
	configure({ format: "%H:%M:%S", formatOlder: null });
	const t1 = new Date(2026, 0, 5, 9, 0, 0).getTime();
	const t2 = new Date(2026, 0, 5, 10, 30, 15).getTime();
	const entries = [userEntry("u1", "look ok", t1)];
	const session = sessionOf(entries);
	boot(session);
	const live = user({ text: "ok" });
	assert.deepEqual(live.render(40), box(40), "no guess before the entry exists");
	entries.push(userEntry("u2", "ok", t2));
	mock.timers.enable({ apis: ["Date"], now: Date.now() + 1000 });
	try {
		assert.equal(stampOf(live.render(40)), "10:30:15");
	} finally {
		mock.timers.reset();
	}
	for (let frame = 0; frame < 5; frame++) live.render(40);
	assert.ok(session.reads() <= 2, `getEntries() copied the session ${session.reads()} times`);
});

test("two live messages with the same text get their own times", () => {
	configure({ format: "%H:%M:%S", formatOlder: null });
	const t1 = new Date(2026, 0, 5, 9, 0, 0).getTime();
	const t2 = new Date(2026, 0, 5, 9, 5, 0).getTime();
	const entries = [userEntry("u1", "continue", t1)];
	boot(sessionOf(entries));
	const first = user({ text: "continue" });
	assert.equal(stampOf(first.render(40)), "09:00:00");
	entries.push(userEntry("u2", "continue", t2));
	const second = user({ text: "continue" });
	assert.equal(stampOf(second.render(40)), "09:05:00");
	assert.equal(stampOf(first.render(40)), "09:00:00");
});

test("a user message announced by message_start is stamped without reading the session", () => {
	configure({ format: "%H:%M:%S", formatOlder: null });
	const t = new Date(2026, 0, 5, 11, 12, 13).getTime();
	const session = sessionOf([]);
	const { handlers } = boot(session);
	for (const handler of handlers.message_start ?? []) {
		handler({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "from the event" }], timestamp: t } }, {});
	}
	assert.equal(stampOf(user({ text: "from the event" }).render(40)), "11:12:13");
});

test("a user message whose time cannot be resolved gets no guessed stamp", () => {
	configure({ format: "%H:%M", formatOlder: null });
	boot(sessionOf([]));
	assert.deepEqual(user({ text: "never saved" }).render(40), box(40));
});

// --- correctness ---------------------------------------------------------------
test("a stamp painted before midnight switches to the older format after it", () => {
	const evening = new Date(2026, 0, 10, 23, 59, 0).getTime();
	mock.timers.enable({ apis: ["Date"], now: evening });
	try {
		configure({ format: "%H:%M", formatOlder: "%Y-%m-%d" });
		const component = new pi.AssistantMessageComponent(box(40), evening - 30_000);
		assert.equal(stampOf(component.render(40)), "23:58");
		mock.timers.tick(5 * 60_000);
		assert.equal(stampOf(component.render(40)), "2026-01-10");
	} finally {
		mock.timers.reset();
	}
});

test("changing only the older format repaints already stamped older messages", () => {
	configure({ format: "%H:%M", formatOlder: "%Y-%m-%d" });
	const component = new pi.AssistantMessageComponent(box(40), new Date(2001, 0, 2, 3, 4).getTime());
	assert.equal(stampOf(component.render(40)), "2001-01-02");
	configure({ format: "%H:%M", formatOlder: "%d/%m/%Y" });
	assert.equal(stampOf(component.render(40)), "02/01/2001");
});

test("%j is the zero-padded three-digit day of the year", () => {
	assert.equal(ext.strftime(new Date(2026, 0, 1), "%j"), "001");
	assert.equal(ext.strftime(new Date(2026, 1, 3), "%j"), "034");
	assert.equal(ext.strftime(new Date(2024, 11, 31, 23, 59), "%j"), "366");
});

test("relative ages never round up into the next unit", () => {
	const now = new Date(2026, 0, 1, 12, 0, 0).getTime();
	assert.equal(ext.formatStamp(now - 30_000, ext.RELATIVE, now), "now");
	assert.equal(ext.formatStamp(now - 90_000, ext.RELATIVE, now), "1 min ago");
	assert.equal(ext.formatStamp(now - (50 * 60 + 31) * 1000, ext.RELATIVE, now), "50 min ago");
	assert.equal(ext.formatStamp(now - 90 * 60_000, ext.RELATIVE, now), "1 h ago");
	assert.equal(ext.formatStamp(now - 36 * 3_600_000, ext.RELATIVE, now), "1 d ago");
});

test("a relative stamp changes exactly when its age crosses into the next unit", () => {
	const start = new Date(2026, 0, 10, 12, 0, 0).getTime();
	mock.timers.enable({ apis: ["Date"], now: start });
	try {
		configure({ format: ext.RELATIVE, formatOlder: null });
		const component = new pi.AssistantMessageComponent(box(40), start - (4 * 60 + 55) * 1000);
		assert.equal(stampOf(component.render(40)), "4 min ago");
		mock.timers.tick(4_999);
		assert.equal(stampOf(component.render(40)), "4 min ago");
		mock.timers.tick(1);
		assert.equal(stampOf(component.render(40)), "5 min ago");
	} finally {
		mock.timers.reset();
	}
});

test("the next change of a relative stamp is the next minute, hour or day of its age", () => {
	const ms = new Date(2026, 0, 1, 12, 0, 0).getTime();
	const next = (age) => ext.nextRelativeChange(ms, ms + age) - ms;
	assert.equal(next(5_000), 60_000); // "now" -> "1 min ago"
	assert.equal(next(90_000), 120_000);
	assert.equal(next(59 * 60_000 + 59_999), 3_600_000); // "59 min ago" -> "1 h ago"
	assert.equal(next(2 * 3_600_000 + 1), 3 * 3_600_000);
	assert.equal(next(23 * 3_600_000 + 5), 86_400_000); // "23 h ago" -> "1 d ago"
	assert.equal(next(3 * 86_400_000 + 5), 4 * 86_400_000); // days, weeks, months and years all turn on a day
	assert.equal(next(-5_000), 60_000); // a clock behind the message: "now" until a minute after it
});

test("the config file no longer carries a locale and names are always English", () => {
	ext.writeConfig({ ...ext.DEFAULTS });
	assert.equal("locale" in JSON.parse(readFileSync(cfgPath, "utf8")), false);
	assert.equal("locale" in ext.parseConfig({ locale: "es" }), false);
	assert.equal(ext.strftime(new Date(2026, 10, 14), "%a %A %b %B"), "Sat Saturday Nov November");
});

// --- /gentle:timestamps menu ---------------------------------------------------------
function menu(steps, overrides = {}, typed = undefined) {
	configure(overrides);
	const notes = [];
	const inputs = [];
	const { command } = boot(undefined);
	const ctx = { ui: {
		notify: (message, type) => notes.push({ message, type }),
		input: async (title) => { inputs.push(title); return typed; },
		custom: async (factory) => {
			const step = steps.shift();
			assert.ok(step, "unexpected menu screen");
			let result;
			const component = factory({ requestRender() {} }, { fg: (_role, value) => value },
				{ matches: (data, action) => action === `tui.select.${data}` }, (value) => { result = value; });
			const lines = component.render(80).map(strip);
			assert.equal(lines[0], step.title);
			step.inspect?.(lines, component);
			for (const key of step.keys ?? ["cancel"]) component.handleInput(key);
			return result;
		},
	} };
	return { run: () => command.handler("", ctx), notes, inputs };
}
const selectedRow = (lines) => lines.find((line) => line.startsWith("●"));
const down = (n) => [...Array(n).fill("down"), "confirm"];

test("older messages default to Smart numeric", () => {
	ext.writeConfig({ ...ext.DEFAULTS });
	ext.syncConfig();
	assert.equal(ext.DEFAULTS.formatOlder, ext.SMART_NUMERIC);
	const lines = new pi.AssistantMessageComponent(box(40), new Date(2001, 0, 2, 3, 4).getTime()).render(40);
	assert.equal(stampOf(lines), "02/01/01 03:04");
});

test("Smart adapts to the message's age", () => {
	const now = new Date(2026, 10, 18, 15, 0).getTime(); // Wednesday 18 Nov 2026
	const at = (...parts) => ext.formatStamp(new Date(...parts).getTime(), ext.SMART, now);
	assert.equal(at(2026, 10, 18, 9, 5), "09:05");
	assert.equal(at(2026, 10, 17, 23, 59), "17 Nov 23:59"); // yesterday is a date too: no "Yesterday", no weekday
	assert.equal(at(2026, 10, 16, 23, 59), "16 Nov 23:59");
	assert.equal(at(2026, 10, 13, 14, 32), "13 Nov 14:32");
	assert.equal(at(2026, 0, 2, 8, 0), "2 Jan 08:00");
	assert.equal(at(2025, 11, 31, 8, 0), "31 Dec 2025 08:00"); // another year: the year is added, the time stays
	const jan1 = new Date(2027, 0, 1, 12, 0).getTime();
	assert.equal(ext.formatStamp(new Date(2026, 11, 31, 22, 10).getTime(), ext.SMART, jan1), "31 Dec 2026 22:10");
	assert.equal(ext.formatStamp(new Date(2026, 11, 30, 10, 0).getTime(), ext.SMART, jan1), "30 Dec 2026 10:00");
});

test("Smart numeric follows the same rule with numeric dates", () => {
	const now = new Date(2027, 0, 15, 15, 0).getTime(); // 15 Jan 2027
	const at = (...parts) => ext.formatStamp(new Date(...parts).getTime(), ext.SMART_NUMERIC, now);
	assert.equal(at(2027, 0, 15, 9, 5), "09:05");
	assert.equal(at(2027, 0, 14, 23, 59), "14/01 23:59");
	assert.equal(at(2027, 0, 2, 14, 32), "02/01 14:32");
	assert.equal(at(2026, 11, 31, 14, 32), "31/12/26 14:32");
	assert.equal(at(2025, 2, 10, 8, 0), "10/03/25 08:00");
	const preset = ext.OLDER_PRESETS.find((p) => p.format === ext.SMART_NUMERIC);
	assert.equal(preset?.label, "Smart numeric");
	assert.equal(ext.PRESETS.some((p) => p.format === ext.SMART_NUMERIC), false); // today's date is always today's
});

test("a Smart stamp painted before midnight gains its date after it", () => {
	const evening = new Date(2026, 0, 10, 23, 59, 0).getTime();
	mock.timers.enable({ apis: ["Date"], now: evening });
	try {
		configure({ format: "%H:%M", formatOlder: ext.SMART });
		const component = new pi.AssistantMessageComponent(box(40), evening - 60_000);
		assert.equal(stampOf(component.render(40)), "23:58");
		mock.timers.tick(5 * 60_000);
		assert.equal(stampOf(component.render(40)), "10 Jan 23:58");
	} finally {
		mock.timers.reset();
	}
});

test("the - flag drops the zero padding, for a 12-hour clock without a leading zero", () => {
	assert.equal(ext.strftime(new Date(2026, 0, 5, 14, 5), "%-I:%M %p"), "2:05 PM");
	assert.equal(ext.strftime(new Date(2026, 0, 5, 9, 4), "%-I:%M %p"), "9:04 AM");
	assert.equal(ext.strftime(new Date(2026, 0, 5, 0, 7), "%-H:%M"), "0:07");
	assert.equal(ext.strftime(new Date(2026, 0, 5), "%-d/%-m %-j"), "5/1 5");
	assert.equal(ext.strftime(new Date(2026, 0, 5), "%-Q"), "%-Q");
});

test("16/11-style date + time stays selectable for today and for older messages", async () => {
	assert.ok(ext.PRESETS.some((p) => p.label === "Date + time" && p.format === "%d/%m %H:%M"));
	assert.ok(ext.OLDER_PRESETS.some((p) => p.label === "Date + time" && p.format === "%d/%m %H:%M"));
	const h = menu([
		{ title: "Message timestamps", keys: down(3) },
		{ title: "Older messages format", keys: ["confirm"], inspect(lines) {
			assert.match(selectedRow(lines), /^● Date \+ time · /);
		} },
		{ title: "Message timestamps" },
	], { formatOlder: "%d/%m %H:%M" });
	await h.run();
	assert.equal(ext.readConfig().formatOlder, "%d/%m %H:%M");
});

test("styles are Minimal, Accent and Badge, and the notice uses those names", async () => {
	assert.deepEqual(ext.STYLES.map((s) => [s.label, s.value]),
		[["Minimal", "plain"], ["Accent", "accent"], ["Badge", "block"]]);
	const h = menu([
		{ title: "Message timestamps", keys: down(2), inspect(lines) { assert.match(lines[3], /^○ Style\s+Minimal$/); } },
		{ title: "Stamp style", keys: down(2), inspect(lines) {
			assert.deepEqual(lines.slice(1, -1), ["● Minimal", "○ Accent", "○ Badge"]);
		} },
		{ title: "Message timestamps" },
	]);
	await h.run();
	assert.equal(ext.readConfig().style, "block");
	assert.match(h.notes.at(-1).message, /, style Badge$/);
});

test("accent is read back and the removed brackets style falls back to Minimal", () => {
	assert.equal(ext.parseConfig({ style: "accent" }).style, "accent");
	assert.equal(ext.parseConfig({ style: "brackets" }).style, "plain");
});

test("Badge looks like the sidebar cards: panel surface, thin border-colored bars on both sides and muted text", () => {
	const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const SURFACE = "\x1b[48;2;1;1;1m", BAR = "\x1b[38;2;2;2;2m", MUTED = "\x1b[38;2;3;3;3m";
	const rgb = { r: 1, g: 1, b: 1 };
	globalThis[key] = {
		colors: { customMessageBg: rgb, muted: rgb, border: rgb },
		getBgAnsi: (t) => (t === "customMessageBg" ? SURFACE : ""),
		getFgAnsi: (t) => ({ muted: MUTED, border: BAR })[t] ?? "",
	};
	try {
		configure({ style: "block", format: "%H:%M", formatOlder: null });
		const now = Date.now();
		const lines = new pi.AssistantMessageComponent(box(40), now).render(40);
		const stamp = ext.strftime(new Date(now), "%H:%M");
		// Thin bars on both sides, drawn on the chip surface: ▏ hugs the left edge of its cell and ▕ the
		// right one, so the chip starts and ends exactly at the bars and both sit as far from the stamp.
		assert.ok(lines[0].includes(`${BG}${" ".repeat(40 - 7)}\x1b[49m${SURFACE}${BAR}▏${MUTED}${stamp}${BAR}▕`), JSON.stringify(lines[0]));
		assert.ok(lines[0].endsWith("▕\x1b[39;22m\x1b[49m"), JSON.stringify(lines[0]));
		assert.equal(visibleWidth(lines[0]), 40);
		assert.equal(stampOf(lines), `▏${stamp}▕`);
	} finally {
		delete globalThis[key];
	}
});

test("Accent paints the stamp in the theme's accent color, without a chip", () => {
	const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const ACCENT = "\x1b[38;2;11;22;33m";
	globalThis[key] = { colors: { accent: { r: 11, g: 22, b: 33 } }, getFgAnsi: (t) => (t === "accent" ? ACCENT : ""), getBgAnsi: () => "" };
	try {
		configure({ style: "accent", format: "%H:%M", formatOlder: null });
		const now = Date.now();
		const lines = new pi.AssistantMessageComponent(box(40), now).render(40);
		assert.ok(lines[0].includes(`${ACCENT}${ext.strftime(new Date(now), "%H:%M")}`));
		assert.equal((lines[0].match(/48;2;/g) ?? []).length, 1, "only the box background");
		assert.equal(visibleWidth(lines[0]), 40);
	} finally {
		delete globalThis[key];
	}
});

test("Accent without a reachable theme still paints a colored stamp", () => {
	configure({ style: "accent", format: "%H:%M", formatOlder: null });
	const now = Date.now();
	const lines = new pi.AssistantMessageComponent(box(40), now).render(40);
	assert.equal(stampOf(lines), ext.strftime(new Date(now), "%H:%M"));
	assert.match(lines[0], /\x1b\[3[0-9;]*m/);
});

test("a settings file still saying brackets paints the Minimal stamp, without quotes", () => {
	writeFileSync(cfgPath, JSON.stringify({ ...ext.DEFAULTS, style: "brackets", format: "%H:%M", formatOlder: null }));
	ext.syncConfig();
	const now = Date.now();
	const lines = new pi.AssistantMessageComponent(box(40), now).render(40);
	assert.equal(stampOf(lines), ext.strftime(new Date(now), "%H:%M"));
});

test("the main menu rows line up, with Older messages instead of an Advanced submenu", async () => {
	const h = menu([{ title: "Message timestamps", inspect(lines) {
		const rows = lines.slice(1, -1).map((l) => l.slice(2));
		const labels = ["Timestamps", "Format", "Style", "Older messages"];
		assert.equal(rows.length, labels.length);
		// Every value starts in the same column, right after the longest label.
		rows.forEach((r, i) => {
			assert.ok(r.startsWith(labels[i].padEnd(14) + " "), r);
			assert.notEqual(r[15], " ", r);
		});
	} }]);
	await h.run();
});

test("each format option explains itself in a help line that follows the cursor", async () => {
	const strip2 = (component) => component.render(80).map(strip); // help rows fit 80 columns
	const h = menu([
		{ title: "Message timestamps", keys: down(3) },
		{ title: "Older messages format", inspect(lines, component) {
			assert.equal(lines.at(-2), "14:32 today · 16/11 14:32 this year · 16/11/25 14:32 before"); // opens on the default
			component.handleInput("up"); // Smart
			assert.equal(strip2(component).at(-2), "14:32 today · 16 Nov 14:32 this year · 16 Nov 2025 14:32 before");
			component.handleInput("down"); component.handleInput("down"); // Date + time
			assert.match(strip2(component).at(-2), /16\/11 14:32/);
			component.handleInput("down"); component.handleInput("down"); // Relative
			assert.equal(strip2(component).at(-2), "Time since, rounded down: now, 5 min, 2 h, 3 d, 2 w, 3 mo, 1 y ago");
			component.handleInput("down"); // Custom…
			assert.match(strip2(component).at(-2), /^Type your own: %H:%M → 14:32 · %-I:%M %p → 2:32 PM/);
		} },
		{ title: "Message timestamps" },
	]);
	await h.run();
});

test("the main menu has no help line", async () => {
	const h = menu([{ title: "Message timestamps", inspect(lines) {
		assert.equal(lines.length, 6);
		assert.equal(lines.at(-1), "↑/↓ navigate · Enter select · Esc close");
	} }]);
	await h.run();
});

test("Custom asks with examples instead of a bare strftime prompt", async () => {
	const h = menu([
		{ title: "Message timestamps", keys: down(1) },
		{ title: "Timestamp format", keys: ["up", "confirm"] },
		{ title: "Message timestamps" },
	], {}, "at %H:%M");
	await h.run();
	assert.equal(h.inputs.length, 1);
	assert.match(h.inputs[0], /%H:%M → 14:32/);
	assert.match(h.inputs[0], /%-I:%M %p → 2:32 PM/);
	assert.equal(ext.readConfig().format, "at %H:%M");
});

test("Day + month is no longer offered, and a saved one shows as Current", async () => {
	assert.equal(ext.OLDER_PRESETS.some((p) => p.label === "Day + month"), false);
	const h = menu([
		{ title: "Message timestamps", keys: down(3) },
		{ title: "Older messages format", keys: ["confirm"], inspect(lines) {
			assert.match(selectedRow(lines), /^● Current · .* \(%-d %b %H:%M\)$/);
		} },
		{ title: "Message timestamps" },
	], { formatOlder: "%-d %b %H:%M" });
	await h.run();
	assert.equal(ext.readConfig().formatOlder, "%-d %b %H:%M");
});

test("the older-format picker opens on the default Smart numeric and lists the older presets", async () => {
	const h = menu([
		{ title: "Message timestamps", keys: down(3) },
		{ title: "Older messages format", inspect(lines) {
			assert.match(selectedRow(lines), /^● Smart numeric · /);
			assert.deepEqual(lines.slice(1, -2).map((l) => l.slice(2).split(" · ")[0]),
				["Same as today", "Smart", "Smart numeric", "Date + time", "ISO date + time", "Relative", "Custom…"]);
		} },
		{ title: "Message timestamps" },
	]);
	await h.run();
	assert.equal(ext.readConfig().formatOlder, ext.SMART_NUMERIC);
});

test("the older-format picker opens on the current value and Enter keeps it", async () => {
	const h = menu([
		{ title: "Message timestamps", keys: down(3) },
		{ title: "Older messages format", keys: ["confirm"], inspect(lines) {
			assert.match(selectedRow(lines), /^● Current · .* \(%a %H:%M\)$/);
		} },
		{ title: "Message timestamps" },
	], { formatOlder: "%a %H:%M" });
	await h.run();
	assert.equal(ext.readConfig().formatOlder, "%a %H:%M");
});

test("a custom format shows as the current row and Enter keeps it", async () => {
	const h = menu([
		{ title: "Message timestamps", keys: down(1) },
		{ title: "Timestamp format", keys: ["confirm"], inspect(lines) {
			assert.match(selectedRow(lines), /^● Current · /);
		} },
		{ title: "Message timestamps" },
	], { format: "%I:%M %p" });
	await h.run();
	assert.equal(ext.readConfig().format, "%I:%M %p");
});

test("the older-format picker accepts a custom strftime format", async () => {
	const h = menu([
		{ title: "Message timestamps", keys: down(3) },
		{ title: "Older messages format", inspect(lines) {
			assert.equal(lines.at(-3), "○ Custom…");
		}, keys: ["up", "confirm"] },
		{ title: "Message timestamps" },
	], { formatOlder: null }, "%e %b %H:%M");
	await h.run();
	assert.equal(ext.readConfig().formatOlder, "%e %b %H:%M");
	assert.equal(h.inputs.length, 1);
});

test("a format argument sets today's format and keeps the older-messages format", async () => {
	configure({ formatOlder: "%Y-%m-%d" });
	const notes = [];
	const { command } = boot(undefined);
	await command.handler("%H:%M:%S", { ui: { notify: (message, type) => notes.push({ message, type }) } });
	assert.deepEqual(ext.readConfig(), { ...ext.DEFAULTS, format: "%H:%M:%S", formatOlder: "%Y-%m-%d" });
	assert.deepEqual(notes, [{ message: "gentle-timestamps: %H:%M:%S, older %Y-%m-%d", type: "info" }]);
	const old = new pi.AssistantMessageComponent(box(40), new Date(2001, 0, 2, 3, 4).getTime());
	assert.equal(stampOf(old.render(40)), "2001-01-02");
});

test("an empty Custom input cancels instead of hiding the stamps", async () => {
	const h = menu([
		{ title: "Message timestamps", keys: down(1) },
		{ title: "Timestamp format", keys: ["up", "confirm"] },
		{ title: "Message timestamps" },
	], { formatOlder: "%Y-%m-%d" }, "   ");
	await h.run();
	assert.equal(h.inputs.length, 1);
	assert.deepEqual(ext.readConfig(), { ...ext.DEFAULTS, formatOlder: "%Y-%m-%d" });
	assert.deepEqual(h.notes, []);
	const now = Date.now();
	assert.equal(stampOf(new pi.AssistantMessageComponent(box(40), now).render(40)), ext.strftime(new Date(now), "%H:%M"));
});

test("choosing a format after a hidden pair restores the default older format", async () => {
	const h = menu([
		{ title: "Message timestamps", keys: down(1) },
		{ title: "Timestamp format", keys: ["down", "down", "confirm"], inspect(lines) {
			assert.equal(selectedRow(lines), "● Current · hidden");
		} }, // Current -> Custom… -> Time
		{ title: "Message timestamps" },
	], { format: "", formatOlder: "" });
	await h.run();
	assert.deepEqual(ext.readConfig(), { ...ext.DEFAULTS, format: "%H:%M" });
	const old = new pi.AssistantMessageComponent(box(40), new Date(2001, 0, 2, 3, 4).getTime());
	assert.equal(stampOf(old.render(40)), "02/01/01 03:04");
});

test("a hidden older format chosen on its own is kept when today's format changes", async () => {
	configure({ format: "%H:%M", formatOlder: "" });
	const { command } = boot(undefined);
	await command.handler("%R", { ui: { notify() {} } });
	assert.deepEqual(ext.readConfig(), { ...ext.DEFAULTS, format: "%R", formatOlder: "" });
});

test("a settings file that cannot be written warns and still applies for this session", async () => {
	configure();
	const blocker = join(dir, "not-a-dir");
	writeFileSync(blocker, "x");
	process.env.GENTLE_TIMESTAMPS_CONFIG = join(blocker, "ext.json");
	try {
		const notes = [];
		const { command } = boot(undefined);
		await command.handler("off", { ui: { notify: (message, type) => notes.push({ message, type }) } });
		assert.equal(notes.at(-1).type, "warning");
		assert.match(notes.at(-1).message, /could not save/);
		assert.deepEqual(new pi.AssistantMessageComponent(box(40), Date.now()).render(40), box(40));
	} finally {
		process.env.GENTLE_TIMESTAMPS_CONFIG = cfgPath;
		configure();
	}
});

// --- idle refresh ----------------------------------------------------------------
test("relative stamps refresh while idle, and only while a relative format is shown", () => {
	mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	try {
		configure({ format: ext.RELATIVE, formatOlder: null });
		let frames = 0;
		const { handlers } = boot(sessionOf([]), { setStatus: () => { frames++; } });
		mock.timers.tick(60_000);
		assert.ok(frames >= 1, "expected a repaint request");
		configure({ format: "%H:%M", formatOlder: null });
		const before = frames;
		mock.timers.tick(120_000);
		assert.equal(frames, before, "absolute formats must not wake the TUI");
		configure({ format: ext.RELATIVE, formatOlder: null });
		for (const handler of handlers.session_shutdown ?? []) handler({ type: "session_shutdown" }, {});
		const stopped = frames;
		mock.timers.tick(120_000);
		assert.equal(frames, stopped, "no repaint requests after shutdown");
	} finally {
		mock.timers.reset();
	}
});
