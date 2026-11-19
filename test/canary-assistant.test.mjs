// Runtime canary, assistant boxes: a live assistant box legitimately has no time for a
// while, so this kind is the only timed one, and one resolved box clears it. The warning
// is per process, so this kind has its own file and the tests run in order.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "timestamps-canary-assistant-"));
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

const emptySession = () => ({ getEntries: () => [], getEntryCount: () => 0, getEntry: () => undefined });
function boot(sessionManager, ui) {
	const handlers = {};
	ext.default({
		on: (name, handler) => (handlers[name] ??= []).push(handler),
		registerCommand() {},
	});
	for (const handler of handlers.session_start ?? []) handler({ type: "session_start" }, { sessionManager, ui, hasUI: true });
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
// No `lastMessage` and no `timestamp`: nothing to read a time from.
const timeless = () => new pi.AssistantMessageComponent(box(40), undefined);
const three = () => [timeless(), timeless(), timeless()];

test("no warning before the grace period", () => {
	const { calls, ui } = spy();
	boot(emptySession(), ui);
	const components = three();
	withClock((advance) => {
		renderAll(components);
		advance(59_000);
		renderAll(components);
	});
	assert.deepEqual(calls, []);
});

test("an assistant box that resolved keeps unreadable ones from warning", () => {
	const { calls, ui } = spy();
	boot(emptySession(), ui);
	const written = new Date(2026, 0, 5, 9, 41, 0).getTime();
	const resolved = new pi.AssistantMessageComponent(box(40), written);
	const components = [resolved, ...three()];
	withClock((advance) => {
		renderAll(components);
		advance(61_000);
		renderAll(components);
		assert.equal(stampOf(resolved.render(40)), "09:41");
	});
	assert.deepEqual(calls, []);
});

test("assistant boxes that stay without a readable time warn exactly once", () => {
	const { calls, ui } = spy();
	withClock((advance) => {
		boot(emptySession(), ui);
		const components = three();
		renderAll(components);
		assert.deepEqual(calls, [], "nothing is reported on the first frame");
		advance(61_000);
		const lines = renderAll(components);
		assert.deepEqual(calls, [WARNING]);
		// The boxes keep their fallback: the current time, content untouched.
		for (const rendered of lines) {
			assert.equal(stampOf(rendered), ext.strftime(new Date(), "%H:%M"));
			assert.equal(strip(rendered[1]), " content ");
		}
		advance(61_000);
		renderAll(components);
		boot(emptySession(), ui);
		const later = three();
		renderAll(later);
		advance(61_000);
		renderAll(later);
		assert.deepEqual(calls, [WARNING], "more frames and a new session do not warn again");
	});
});
