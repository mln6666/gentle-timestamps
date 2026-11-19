// Runtime canary, user boxes: a box whose `text` field is missing is evidence that Pi
// changed. The warning is per process, so this kind has its own file and the tests
// run in order.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "timestamps-canary-user-"));
process.env.GENTLE_TIMESTAMPS_CONFIG = join(dir, "ext.json");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ext = await import("../gentle-timestamps.ts");
const pi = await import("@earendil-works/pi-coding-agent");

ext.writeConfig({ ...ext.DEFAULTS, format: "%H:%M", formatOlder: null });
ext.syncConfig();

const WARNING = { message: "gentle-timestamps: could not read message times (Pi may have changed)", type: "warning" };
const BG = "\x1b[48;2;40;40;40m";
const box = (w) => [BG + " ".repeat(w) + "\x1b[49m", " content ", BG + " ".repeat(w) + "\x1b[49m"];

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
const textless = () => new pi.UserMessageComponent(box(40));

test("two user boxes without a text field do not warn", () => {
	const { calls, ui } = spy();
	boot(emptySession(), ui);
	const components = [textless(), textless()];
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		renderAll(components);
		mock.timers.tick(5 * 60_000);
		for (const lines of renderAll(components)) assert.deepEqual(lines, box(40));
	} finally {
		mock.timers.reset();
	}
	assert.deepEqual(calls, []);
});

test("user boxes without a text field warn exactly once", () => {
	const { calls, ui } = spy();
	boot(emptySession(), ui);
	const components = [textless(), textless(), textless()];
	for (const lines of renderAll(components)) assert.deepEqual(lines, box(40), "an unreadable user box stays unstamped");
	assert.deepEqual(calls, [WARNING], "the first frame is enough: no timing involved");
	renderAll(components);
	textless().render(40);
	assert.deepEqual(calls, [WARNING], "a fourth box does not warn again");
	boot(emptySession(), ui);
	renderAll([textless(), textless(), textless()]);
	assert.deepEqual(calls, [WARNING], "a new session does not warn again in the same process");
});
