// Runtime canary, tool boxes and healthy sessions. The extension reads private fields
// of Pi's components; a missing field is evidence that Pi changed, an unknown time is
// not. The warning is per process, so each kind has its own file and the tests run in order.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "timestamps-canary-"));
process.env.GENTLE_TIMESTAMPS_CONFIG = join(dir, "ext.json");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ext = await import("../gentle-timestamps.ts");
const pi = await import("@earendil-works/pi-coding-agent");

ext.writeConfig({ ...ext.DEFAULTS, format: "%H:%M", formatOlder: null });
ext.syncConfig();

const WARNING = { message: "gentle-timestamps: could not read message times (Pi may have changed)", type: "warning" };
const BG = "\x1b[48;2;40;40;40m";
const strip = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const box = (w) => [BG + " ".repeat(w) + "\x1b[49m", " content ", BG + " ".repeat(w) + "\x1b[49m"];
const stampOf = (lines) => strip(lines[0]).trim();

function sessionOf(entries) {
	return {
		getEntries: () => entries.slice(),
		getEntryCount: () => entries.length,
		getEntry: (id) => entries.find((e) => e.id === id),
	};
}
/** Loads the extension and starts a session; returns the registered event handlers. */
function boot(sessionManager, ui) {
	const handlers = {};
	ext.default({
		on: (name, handler) => (handlers[name] ??= []).push(handler),
		registerCommand() {},
	});
	for (const handler of handlers.session_start ?? []) handler({ type: "session_start" }, { sessionManager, ui, hasUI: true });
	return handlers;
}
const spy = () => {
	const calls = [];
	return { calls, ui: { notify: (message, type) => calls.push({ message, type }) } };
};
const renderAll = (components) => components.map((c) => c.render(40));
/** Runs `body` with a mocked clock; `advance(ms)` moves Date.now() forward. */
const withClock = (body) => {
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		body((ms) => mock.timers.tick(ms));
	} finally {
		mock.timers.reset();
	}
};

const toolEntry = (id, toolIds, ms) => ({
	type: "message", id, timestamp: new Date(ms).toISOString(),
	message: { role: "assistant", timestamp: ms, content: toolIds.map((t) => ({ type: "toolCall", id: t, name: "bash", arguments: {} })) },
});
const tool = (toolCallId) => new pi.ToolExecutionComponent(box(40), { toolCallId });
const user = (fields) => new pi.UserMessageComponent(box(40), fields);
const idlessTools = () => [1, 2, 3].map(() => new pi.ToolExecutionComponent(box(40)));

test("tool boxes that resolve after a long wait do not warn", () => {
	const { calls, ui } = spy();
	const entries = [];
	boot(sessionOf(entries), ui);
	const ids = ["slow-1", "slow-2", "slow-3"];
	const components = ids.map(tool);
	const issued = new Date(2026, 0, 5, 9, 41, 0).getTime();
	withClock((advance) => {
		renderAll(components);
		advance(61_000);
		renderAll(components);
		entries.push(toolEntry("a1", ids, issued));
		advance(1_000);
		for (const lines of renderAll(components)) assert.equal(stampOf(lines), "09:41");
	});
	assert.deepEqual(calls, []);
});

test("tool boxes whose id never appears do not warn", () => {
	const { calls, ui } = spy();
	boot(sessionOf([]), ui);
	const components = ["lost-1", "lost-2", "lost-3"].map(tool);
	withClock((advance) => {
		renderAll(components);
		advance(5 * 60_000);
		renderAll(components);
	});
	assert.deepEqual(calls, []);
});

test("user boxes whose text matches no saved message do not warn", () => {
	const { calls, ui } = spy();
	const handlers = boot(sessionOf([]), ui);
	const sent = Date.now();
	for (const n of [1, 2, 3]) {
		const message = { role: "user", content: `<skill name="s" location="/x">\nbody\n</skill>\n\nargs ${n}`, timestamp: sent + n };
		for (const handler of handlers.message_start ?? []) handler({ type: "message_start", message });
	}
	const components = [1, 2, 3].map((n) => user({ text: `args ${n}` }));
	withClock((advance) => {
		renderAll(components);
		advance(5 * 60_000);
		for (const lines of renderAll(components)) assert.deepEqual(lines, box(40), "an unmatched user box stays unstamped");
	});
	assert.deepEqual(calls, []);
});

test("tool boxes without a toolCallId warn exactly once", () => {
	const { calls, ui } = spy();
	boot(sessionOf([]), ui);
	const components = idlessTools();
	const lines = renderAll(components);
	assert.deepEqual(calls, [WARNING], "the first frame is enough: no timing involved");
	// The boxes keep their fallback: the current time, content untouched.
	for (const rendered of lines) {
		assert.match(stampOf(rendered), /^\d\d:\d\d$/);
		assert.equal(strip(rendered[1]), " content ");
	}
	withClock((advance) => {
		advance(61_000);
		renderAll(components);
		renderAll(idlessTools());
		assert.deepEqual(calls, [WARNING], "more frames and more such boxes do not warn again");
		boot(sessionOf([]), ui);
		renderAll(idlessTools());
		advance(61_000);
		assert.deepEqual(calls, [WARNING], "a new session does not warn again in the same process");
	});
});
