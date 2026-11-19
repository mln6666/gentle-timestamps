import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GENTLE_TIMESTAMPS_CONFIG = join(mkdtempSync(join(tmpdir(), "timestamps-menu-")), "ext.json");
const ext = await import("../gentle-timestamps.ts");
const { AssistantMessageComponent } = await import("@earendil-works/pi-coding-agent");
const strip = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const stamp = (ms = Date.now()) => strip(new AssistantMessageComponent([" ".repeat(80), "content"], ms).render(80)[0]).trim();
const keys = (index) => [...Array(index).fill("down"), "confirm"];
const row = (s) => s.replace(/^[●○] /, "").replace(/\s+/g, " ");

function harness(steps, overrides = {}, input = undefined) {
	ext.writeConfig({ ...ext.DEFAULTS, ...overrides });
	ext.syncConfig();
	const before = readFileSync(process.env.GENTLE_TIMESTAMPS_CONFIG, "utf8");
	const screens = [];
	const notes = [];
	let command;
	ext.default({ on() {}, registerCommand(name, options) { command = options; } });
	const ctx = { ui: {
		notify: (message, type) => notes.push({ message, type }),
		select: async () => { throw new Error("All menu screens must expose their non-selectable Esc hint"); },
		input: async (title) => { assert.match(title, /^Custom format/); return input; },
		custom: async (factory, options) => {
			const step = steps.shift();
			assert.ok(step, "unexpected menu screen");
			let done = false;
			let result;
			const component = factory({ requestRender() {} }, { fg: (_role, value) => value },
				{ matches: (data, action) => action === `tui.select.${data}` },
				(value) => { done = true; result = value; });
			const lines = component.render(80).map(strip);
			screens.push(lines);
			assert.equal(lines[0], step.title);
			assert.equal(options.blocked.kind, "question");
			for (const width of [80, 140, 180]) {
				assert.ok(component.render(width).every((line) => strip(line).length <= width));
			}
			step.inspect?.(lines, component);
			for (const key of step.keys ?? ["cancel"]) component.handleInput(key);
			assert.equal(done, true, "interaction must close through the public callback");
			step.after?.();
			return result;
		},
	} };
	return { command, ctx, screens, notes, before, steps, run: () => command.handler("", ctx) };
}

const main = (index) => ({ title: "Message timestamps", keys: keys(index) });
const close = { title: "Message timestamps" };
const stored = () => ext.readConfig();

test("main menu has four rows, a sample instead of tokens, and a non-selectable Esc hint", async () => {
	const h = harness([close]);
	await h.run();
	const [screen] = h.screens;
	assert.equal(screen.length, 6);
	assert.deepEqual(screen.slice(1, -1).map(row), [
		"Timestamps On", `Format ${ext.strftime(new Date(), "%H:%M")}`, "Style Minimal",
		`Older messages ${ext.formatStamp(Date.now() - 172_800_000, ext.DEFAULTS.formatOlder)}`,
	]);
	assert.equal(screen.at(-1), "↑/↓ navigate · Enter select · Esc close");
	assert.ok(screen.every((line) => !/Locale|Language|%H|Advanced/.test(line)));
	assert.equal(readFileSync(process.env.GENTLE_TIMESTAMPS_CONFIG, "utf8"), h.before);
	assert.deepEqual(h.notes, []);
	assert.equal(h.steps.length, 0);
});

test("Older messages opens its picker straight from the main menu and Esc returns without writes", async () => {
	const h = harness([main(3), { title: "Older messages format" }, close]);
	await h.run();
	assert.equal(readFileSync(process.env.GENTLE_TIMESTAMPS_CONFIG, "utf8"), h.before);
	assert.deepEqual(h.notes, []);
});

const formats = [
	["Time", "%H:%M"], ["12-hour", "%-I:%M %p"], ["Time + relative", "relative-time"], ["Relative", "relative"],
	["Date + time", "%d/%m %H:%M"], ["ISO date + time", "%Y-%m-%d %H:%M"],
];
for (const [index, [label, format]] of formats.entries()) {
	test(`format picker offers seven choices and applies ${label} without changing the older format`, async () => {
		const h = harness([main(1), { title: "Timestamp format", keys: keys(index), inspect(lines) {
			assert.equal(lines.length, 10); // title, six presets, Custom…, help line, keys hint
			assert.deepEqual(lines.slice(1, -3).map((line) => row(line).split(" · ")[0]), formats.map(([name]) => name));
			assert.equal(row(lines.at(-3)), "Custom…");
			assert.equal(lines.at(-1), "↑/↓ preview · Enter confirm · Esc cancel");
		} }, close]);
		await h.run();
		assert.equal(stored().format, format);
		assert.equal(stored().formatOlder, ext.DEFAULTS.formatOlder);
		assert.equal(h.notes.length, 1);
		assert.equal(h.notes[0].type, "info");
		assert.equal(stamp(), ext.formatStamp(Date.now(), format));
	});
}

test("Custom accepts a strftime format and its cancellation preserves config and live stamps", async () => {
	const steps = () => [main(1), { title: "Timestamp format", keys: keys(6) }, close];
	const cancelled = harness(steps());
	await cancelled.run();
	assert.equal(readFileSync(process.env.GENTLE_TIMESTAMPS_CONFIG, "utf8"), cancelled.before);
	assert.equal(stamp(), ext.strftime(new Date(), "%H:%M"));
	assert.deepEqual(cancelled.notes, []);
	const applied = harness(steps(), {}, "%I:%M %p");
	await applied.run();
	assert.equal(stored().format, "%I:%M %p");
	assert.equal(stamp(), ext.strftime(new Date(), "%I:%M %p"));
	assert.equal(applied.notes.length, 1);
});

test("arrows preview, Esc restores, and Enter persists through the public picker", async () => {
	const h = harness([main(1), { title: "Timestamp format", keys: ["cancel"], inspect(_lines, component) {
		component.handleInput("down");
		assert.equal(stamp(), ext.strftime(new Date(), "%-I:%M %p"));
		assert.equal(readFileSync(process.env.GENTLE_TIMESTAMPS_CONFIG, "utf8"), h.before);
	} }, { ...close, inspect() { assert.equal(stamp(), ext.strftime(new Date(), "%H:%M")); } }]);
	await h.run();
	assert.equal(readFileSync(process.env.GENTLE_TIMESTAMPS_CONFIG, "utf8"), h.before);
	assert.deepEqual(h.notes, []);
});

test("older format is editable from the main menu and same-as-today still applies to old messages", async () => {
	const h = harness([main(3), { title: "Older messages format", keys: ["up", "up", "confirm"] }, close]); // Smart numeric -> Smart -> Same as today
	await h.run();
	assert.equal(stored().formatOlder, null);
	assert.equal(stamp(new Date(2001, 0, 2, 3, 4).getTime()), "03:04");
	assert.equal(h.notes.length, 1);
});

test("style picker and timestamp toggle keep their existing behavior", async () => {
	const styled = harness([main(2), { title: "Stamp style", keys: ["down", "down", "confirm"] }, close]);
	await styled.run();
	assert.equal(stored().style, "block");
	assert.equal(styled.notes.length, 1);
	const toggled = harness([main(0), close]);
	await toggled.run();
	assert.equal(stored().enabled, false);
	assert.equal(stamp(), "");
	assert.deepEqual(toggled.notes, [{ message: "gentle-timestamps: timestamps off", type: "info" }]);
});
