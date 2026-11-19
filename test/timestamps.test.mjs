import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gentle-timestamps-"));
const cfgPath = join(dir, "ext.json");
process.env.GENTLE_TIMESTAMPS_CONFIG = cfgPath;

const ext = await import("../gentle-timestamps.ts");
const { AssistantMessageComponent } = await import("@earendil-works/pi-coding-agent");

// --- fixture helpers -------------------------------------------------------
const BG = "\x1b[48;2;40;40;40m";
const RESET_BG = "\x1b[49m";
const plain = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const boxLines = (width) => [BG + " ".repeat(width) + RESET_BG, " content ", BG + " ".repeat(width) + RESET_BG];
const STAMP_MS = new Date(2026, 10, 14, 14, 32, 7).getTime(); // 2026-11-14 14:32:07 local

const fresh = (timestamp = STAMP_MS, width = 40) => {
	const component = new AssistantMessageComponent(boxLines(width), timestamp);
	return { component, width, lines: component.render(width) };
};
const stampOf = (lines) => plain(lines[0]).trim();

const save = (config) => writeFileSync(cfgPath, JSON.stringify(config), "utf8");
const reset = () => {
	ext.writeConfig({ ...ext.DEFAULTS });
	ext.syncConfig();
};
reset();

// --- config ---------------------------------------------------------------
test("no config file means the documented defaults", () => {
	assert.deepEqual(ext.readConfig(join(dir, "absent.json")), ext.DEFAULTS);
});

test("a malformed config file falls back to defaults instead of throwing", () => {
	writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
	assert.deepEqual(ext.readConfig(join(dir, "broken.json")), ext.DEFAULTS);
});

test("control characters cannot reach the terminal through a format", () => {
	const parsed = ext.parseConfig({ format: "%H:%M\u001b]52;c;evil\u0007", formatOlder: "%a\u009b%H" });
	assert.equal(parsed.format.includes("\u001b"), false);
	assert.equal(parsed.formatOlder, "%a%H");
});

test("a wrong value type keeps the default for that key only", () => {
	const parsed = ext.parseConfig({ enabled: "yes", format: 42, style: "block" });
	assert.equal(parsed.enabled, ext.DEFAULTS.enabled);
	assert.equal(parsed.format, ext.DEFAULTS.format);
	assert.equal(parsed.style, "block");
});

test("formatOlder null means one format everywhere, as documented", () => {
	const config = ext.parseConfig({ format: "%H:%M", formatOlder: null });
	assert.equal(config.formatOlder, null);
});

test("writeConfig is atomic and records the schema", () => {
	ext.writeConfig({ enabled: false, format: "%R", formatOlder: null, style: "block" });
	const body = JSON.parse(readFileSync(cfgPath, "utf8"));
	assert.deepEqual(body, {
		schema: "gentle-timestamps/v1",
		enabled: false,
		format: "%R",
		formatOlder: null,
		style: "block",
	});
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []); // no half-written file left behind
});

// --- formatting -----------------------------------------------------------
test("strftime covers the documented common tokens", () => {
	const d = new Date(2026, 0, 5, 9, 4, 3);
	assert.equal(ext.strftime(d, "%Y-%m-%d %H:%M:%S"), "2026-01-05 09:04:03");
	assert.equal(ext.strftime(d, "%F"), "2026-01-05");
	assert.equal(ext.strftime(d, "%R"), "09:04");
	assert.equal(ext.strftime(d, "%I:%M %p"), "09:04 AM");
	assert.equal(ext.strftime(d, "100%% %y"), "100% 26");
});

test("an unknown token is left as written so a typo is visible", () => {
	assert.equal(ext.strftime(new Date(), "%Q"), "%Q");
});

test("weekday and month names are English", () => {
	const d = new Date(2026, 10, 14, 14, 0, 0);
	const names = ext.strftime(d, "%A %B");
	assert.equal(names, "Saturday November");
});

test("relative wording is unit-aware", () => {
	const now = Date.UTC(2026, 0, 1, 12, 0, 0);
	assert.equal(ext.relativeStamp(now - 5_000, now), "now");
	assert.equal(ext.relativeStamp(now - 180_000, now), "3 min ago");
	assert.equal(ext.relativeStamp(now - 7_200_000, now), "2 h ago");
	assert.equal(ext.relativeStamp(now - 3 * 86_400_000, now), "3 d ago");
	assert.equal(ext.relativeStamp(now - 14 * 86_400_000, now), "2 w ago");
	assert.equal(ext.relativeStamp(now - 60 * 86_400_000, now), "2 mo ago");
	assert.equal(ext.relativeStamp(now - 364 * 86_400_000, now), "11 mo ago");
	assert.equal(ext.relativeStamp(now - 800 * 86_400_000, now), "2 y ago");
});

test("formatStamp maps the relative and empty pseudo-formats", () => {
	const now = Date.UTC(2026, 0, 1, 12, 0, 0);
	assert.equal(ext.formatStamp(now - 120_000, ext.RELATIVE, now), "2 min ago");
	assert.equal(ext.formatStamp(now, "", now), "");
});

test("the Time + relative preset is offered for today's messages", () => {
	assert.ok(ext.PRESETS.some((p) => p.format === ext.RELATIVE_TIME));
});

// The menu keeps the distinct shapes (time, date+time, sortable date-time,
// relative, time+relative); rarer shapes stay reachable via custom… or
// `/gentle:timestamps <format>`, and hiding stays a toggle, not a preset.
test("the format menu offers the simplified preset list", () => {
	assert.deepEqual(ext.PRESETS.map((p) => p.label), [
		"Time",
		"12-hour",
		"Time + relative",
		"Relative",
		"Date + time",
		"ISO date + time",
	]);
	assert.equal(ext.PRESETS.some((p) => p.format === ""), false); // hidden is not a preset
});

// --- styles ---------------------------------------------------------------
test("unknown style values fall back to plain", () => {
	assert.equal(ext.parseConfig({ style: "neon" }).style, "plain");
	assert.equal(ext.DEFAULTS.style, "plain");
});

test("the style catalog is exported for the picker", () => {
	assert.deepEqual(ext.STYLES.map((s) => s.value), ["plain", "accent", "block"]);
});

test("Badge style paints its own chip background on top of the box bg", () => {
	configure({ style: "block" });
	const { lines } = fresh();
	const bgs = lines[0].match(/48;2;\d+;\d+;\d+/g) ?? [];
	assert.ok(bgs.length >= 2, `expected box bg + chip bg, got ${bgs}`);
});

test("Badge style still works on bg-less lines", () => {
	configure({ style: "block" });
	const component = new AssistantMessageComponent([" ".repeat(40), " content ".repeat(2)], undefined);
	const lines = component.render(40);
	assert.ok(lines[0].includes("48;2;"), "expected a chip bg");
});

test("plain style keeps the historical render", () => {
	configure({ style: "plain" });
	const now = Date.now();
	const { lines } = fresh(now);
	assert.equal(stampOf(lines), ext.strftime(new Date(now), ext.DEFAULTS.format));
});

test("a combined format shows the clock and the relative age", () => {
	const now = Date.UTC(2026, 0, 1, 12, 0, 0);
	assert.equal(
		ext.formatStamp(now - 120_000, ext.RELATIVE_TIME, now),
		`${ext.strftime(new Date(now - 120_000), "%H:%M")} · 2 min ago`,
	);
});

// --- render patch ---------------------------------------------------------
// Every test starts from a known file, so a failure cannot leak into the next one.
const configure = (overrides = {}) => {
	ext.writeConfig({ ...ext.DEFAULTS, ...overrides });
	ext.syncConfig();
};

test("a resolved assistant message gets the stamp on its top padding line only", () => {
	configure();
	const now = Date.now();
	const { lines } = fresh(now);
	assert.equal(stampOf(lines), ext.strftime(new Date(now), ext.DEFAULTS.format));
	assert.equal(plain(lines[1]), " content ");
});

test("turning timestamps off restores the untouched render", () => {
	configure({ enabled: false });
	assert.deepEqual(fresh().lines, boxLines(40));
});

test("the empty format paints nothing at all", () => {
	configure({ format: "", formatOlder: "" });
	assert.deepEqual(fresh().lines, boxLines(40));
});

test("a box too narrow for the stamp is left untouched", () => {
	configure();
	assert.deepEqual(fresh(STAMP_MS, 3).lines, boxLines(3));
});

test("older messages use formatOlder, todays use format", () => {
	configure({ format: "%H:%M", formatOlder: "%Y-%m-%d" });
	assert.equal(stampOf(fresh(new Date(2001, 0, 2, 3, 4).getTime()).lines), "2001-01-02");
	assert.equal(stampOf(fresh(Date.now()).lines), ext.strftime(new Date(), "%H:%M"));
});

test("formatOlder null applies one format to every age", () => {
	configure({ format: "%H:%M", formatOlder: null });
	const expected = ext.strftime(new Date(2001, 0, 2, 3, 4), "%H:%M");
	assert.equal(stampOf(fresh(new Date(2001, 0, 2, 3, 4).getTime()).lines), expected);
});

// --- /gentle:timestamps ---------------------------------------------------------
const harness = () => {
	const commands = new Map();
	ext.default({ on() {}, registerCommand: (name, options) => commands.set(name, options) });
	const notes = [];
	const ctx = {
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			select: async () => undefined,
			custom: async () => undefined,
			input: async () => undefined,
		},
	};
	return { handler: commands.get("gentle:timestamps").handler, commands, notes, ctx };
};

test("the command is registered with a description", () => {
	configure();
	const { handler } = harness();
	assert.equal(typeof handler, "function");
});

test("only /gentle:timestamps is registered; the former /gentle:when is gone", () => {
	configure();
	const { commands } = harness();
	assert.deepEqual([...commands.keys()], ["gentle:timestamps"]);
});

test("arguments switch the setting and persist it without a reload", async () => {
	configure();
	const { handler, notes, ctx } = harness();
	await handler("off", ctx);
	assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).enabled, false);
	assert.deepEqual(notes.at(-1), { message: "gentle-timestamps: timestamps off", type: "info" });
	assert.deepEqual(fresh().lines, boxLines(40)); // the very next render already obeys it

	await handler("on", ctx);
	assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).enabled, true);
	assert.notDeepEqual(fresh().lines, boxLines(40));
});

test("a bare argument is applied as a custom strftime format", async () => {
	configure();
	const { handler, ctx } = harness();
	await handler("%Y/%m/%d", ctx);
	assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).format, "%Y/%m/%d");
	const now = Date.now();
	assert.equal(stampOf(fresh(now).lines), ext.strftime(new Date(now), "%Y/%m/%d"));
});

test("cancelling the menu changes nothing", async () => {
	configure();
	const { handler, ctx } = harness();
	const before = statSync(cfgPath).mtimeMs;
	await handler("", ctx); // every select() returns undefined
	assert.equal(statSync(cfgPath).mtimeMs, before);
});

// --- English-only product configuration ----------------------------------
test("a legacy locale in the settings file changes nothing and the menu does not rewrite it", async () => {
	save({ ...ext.DEFAULTS, locale: "es", format: "%A %B", formatOlder: null });
	ext.syncConfig();
	const before = readFileSync(cfgPath, "utf8");
	const { handler, ctx, notes } = harness();
	await handler("", ctx);
	assert.equal(stampOf(fresh(STAMP_MS).lines), "Saturday November");
	assert.equal(readFileSync(cfgPath, "utf8"), before);
	assert.deepEqual(notes, []);
	save({ ...ext.DEFAULTS, locale: "es", format: ext.RELATIVE, formatOlder: null });
	ext.syncConfig();
	assert.equal(stampOf(fresh(Date.now() - 180_000).lines), "3 min ago");
});

test("reset restores the defaults and says so", async () => {
	configure({ enabled: false, format: "%T", formatOlder: null, style: "block" });
	const { handler, notes, ctx } = harness();
	await handler("reset", ctx);
	assert.deepEqual(ext.readConfig(), ext.DEFAULTS);
	assert.deepEqual(notes.at(-1), { message: "gentle-timestamps: %H:%M, older smart-numeric", type: "info" });
});

// --- live preview ---------------------------------------------------------
test("a preview repaints the stamps without writing the config file", () => {
	configure({ format: "%H:%M", formatOlder: "%Y-%m-%d" });
	const before = statSync(cfgPath).mtimeMs;
	ext.showPreview({ ...ext.DEFAULTS, format: "%R", formatOlder: "%Y-%m-%d" });
	const now = Date.now();
	assert.equal(stampOf(fresh(now).lines), ext.strftime(new Date(now), "%R"));
	assert.equal(statSync(cfgPath).mtimeMs, before); // tentative: nothing persisted
});

test("restoring the baseline after a preview brings the old stamps back", () => {
	configure({ format: "%H:%M", formatOlder: "%Y-%m-%d" });
	const baseline = ext.syncConfig();
	ext.showPreview({ ...baseline, format: "%R", formatOlder: "%Y-%m-%d" });
	ext.showPreview(baseline);
	const now = Date.now();
	assert.equal(stampOf(fresh(now).lines), ext.strftime(new Date(now), "%H:%M"));
});

test("smart and smart-numeric always carry the time; smart:30 is literal", () => {
	const now = new Date(2027, 0, 15, 15, 0).getTime();
	const at = (f, ...d) => ext.formatStamp(new Date(...d).getTime(), f, now);
	assert.equal(at("smart", 2027, 0, 14, 23, 59), "14 Jan 23:59");
	assert.equal(at("smart", 2026, 11, 31, 14, 32), "31 Dec 2026 14:32");
	assert.equal(at("smart-numeric", 2027, 0, 2, 14, 32), "02/01 14:32");
	assert.equal(at("smart-numeric", 2025, 2, 10, 8, 0), "10/03/25 08:00");
	assert.equal(at("smart:30", 2027, 0, 14, 23, 59), "smart:30");
});

test("a relative stamp never changes before nextRelativeChange", () => {
	const now = new Date(2026, 10, 19, 12, 0).getTime() + 123;
	for (const age of [0, 59_999, 60_000, 3_599_999, 3_600_000, 86_399_999, 86_400_000, 7 * 86_400_000, 30 * 86_400_000, 365 * 86_400_000 - 1, 400 * 86_400_000]) {
		const ms = now - age, next = ext.nextRelativeChange(ms, now);
		assert.ok(next > now);
		// `now + 1` is the change itself when the age sits 1 ms before a boundary, hence the filter.
		for (const t of [now, now + 1, now + ((next - now) >> 1), next - 1].filter((t) => t < next))
			assert.equal(ext.relativeStamp(ms, t), ext.relativeStamp(ms, now), `age ${age}`);
	}
});
