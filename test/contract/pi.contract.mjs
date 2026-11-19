// Contract with the real Pi packages: the exports, theme tokens and component fields that
// gentle-timestamps.ts relies on, and the extension stamping real components end to end.
// Run with `npm run test:contract`; every test is skipped when Pi is not installed.
// Only real Pi objects are used here; the stubs under test/stub/ belong to `npm test`.
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKIP_REASON } from "../../scripts/pi-root.mjs";
import { piRoot } from "./setup.mjs";

const skip = piRoot ? false : SKIP_REASON;
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const WIDTH = 60;
const ISO = "2026-11-16T14:32:00.000Z";
const MS = Date.parse(ISO);
const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
// CSI and BEL-terminated OSC sequences, enough to read the text of a rendered line.
const strip = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");
const assistantMessage = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });

let pi;
let visibleWidth;
let ext;
let dir;
if (piRoot) {
	dir = mkdtempSync(join(tmpdir(), "timestamps-contract-"));
	const configFile = join(dir, "ext.json");
	writeFileSync(configFile, JSON.stringify({ format: "%H:%M", formatOlder: null }));
	process.env.GENTLE_TIMESTAMPS_CONFIG = configFile;
	pi = await import("@earendil-works/pi-coding-agent");
	({ visibleWidth } = await import("@earendil-works/pi-tui"));
	pi.initTheme(); // components read the theme while they are built
	ext = await import("../../gentle-timestamps.ts");
}
after(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The rendered lines, after checking none is wider than the terminal and the top padding line carries the stamp. */
function assertStamped(component, expected) {
	const lines = component.render(WIDTH);
	for (const line of lines) assert.ok(visibleWidth(line) <= WIDTH, `line wider than ${WIDTH}: ${JSON.stringify(line)}`);
	assert.equal(strip(lines[0]).trim(), expected);
	return lines;
}

test("Pi exports the three patched components and visibleWidth", { skip }, () => {
	for (const name of ["UserMessageComponent", "AssistantMessageComponent", "ToolExecutionComponent"]) {
		assert.equal(typeof pi[name], "function", name);
		assert.equal(typeof pi[name].prototype.render, "function", `${name}.prototype.render`);
	}
	assert.equal(visibleWidth("ab日本c"), 7);
});

test("the global theme resolves the tokens the stamp styles use", { skip }, () => {
	const theme = globalThis[THEME_KEY];
	assert.equal(typeof theme, "object");
	assert.equal(typeof theme.colors, "object");
	assert.equal(typeof theme.getFgAnsi, "function");
	assert.equal(typeof theme.getBgAnsi, "function");
	const tokens = [["customMessageBg", "bg"], ["muted", "fg"], ["border", "fg"], ["accent", "fg"]];
	for (const [token, kind] of tokens) {
		assert.ok(theme.colors[token], `colors.${token}`); // themeAnsi() only asks for tokens listed here
		const ansi = kind === "bg" ? theme.getBgAnsi(token) : theme.getFgAnsi(token);
		assert.equal(typeof ansi, "string", token);
		assert.notEqual(ansi, "", token);
	}
});

test("the components carry the fields message times are read from", { skip }, () => {
	const user = new pi.UserMessageComponent("hello", undefined, undefined, undefined, "entry-1", ISO);
	assert.equal(user.text, "hello");
	assert.equal(user.messageId, "entry-1");
	assert.equal(user.timestamp, ISO);

	const tool = new pi.ToolExecutionComponent("bash", "call-1", { command: "ls" }, {}, undefined, undefined, dir);
	assert.equal(tool.toolCallId, "call-1");

	const assistant = new pi.AssistantMessageComponent();
	assert.equal(assistant.lastMessage, undefined);
	assistant.updateContent(assistantMessage("hi", MS));
	assert.equal(assistant.lastMessage.timestamp, MS);
});

test("a real user message box is stamped with its time", { skip }, () => {
	const user = new pi.UserMessageComponent("hello", undefined, undefined, undefined, undefined, ISO);
	const lines = assertStamped(user, clock(MS));
	assert.ok(lines.some((line) => strip(line).includes("hello")), "the message text is still rendered");
});

test("a real assistant message box is stamped with its message time", { skip }, () => {
	const assistant = new pi.AssistantMessageComponent(assistantMessage("the answer", MS));
	const lines = assertStamped(assistant, clock(MS));
	assert.ok(lines.some((line) => strip(line).includes("the answer")), "the message text is still rendered");
});

test("a text-only user box is stamped once message_start gives its time", { skip }, () => {
	const handlers = {};
	ext.default({
		on: (name, handler) => (handlers[name] ??= []).push(handler),
		registerCommand() {},
	});
	const text = "sent live, no id and no timestamp";
	const sentAt = MS + 5 * 60_000;
	const before = new pi.UserMessageComponent(text).render(WIDTH);
	assert.equal(strip(before[0]).trim(), "", "no time is known yet, so no stamp");

	for (const handler of handlers.message_start ?? []) {
		handler({ type: "message_start", message: { role: "user", content: [{ type: "text", text }], timestamp: sentAt } });
	}
	assertStamped(new pi.UserMessageComponent(text), clock(sentAt));
});

// A time that is merely unknown must not look like a Pi change: user boxes whose text matches no
// saved message (skill sends) and tool boxes whose message is not saved yet (slow tool calls).
test("real boxes whose time is unknown never trigger the Pi-changed warning", { skip }, () => {
	const handlers = {};
	ext.default({
		on: (name, handler) => (handlers[name] ??= []).push(handler),
		registerCommand() {},
	});
	const warnings = [];
	const sessionManager = { getEntries: () => [], getEntryCount: () => 0, getEntry: () => undefined };
	const ui = { notify: (message, type) => warnings.push({ message, type }), setStatus() {} };
	const emit = (name) => {
		for (const handler of handlers[name] ?? []) handler({ type: name }, { sessionManager, ui, hasUI: true });
	};
	emit("session_start");
	const boxes = [
		...[1, 2, 3].map((n) => new pi.UserMessageComponent(`skill arguments ${n}`)),
		...[1, 2, 3].map((n) => new pi.ToolExecutionComponent("bash", `slow-call-${n}`, { command: "ls" }, {}, undefined, undefined, dir)),
	];
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		for (const box of boxes) box.render(WIDTH);
		mock.timers.tick(5 * 60_000);
		for (const box of boxes) box.render(WIDTH);
	} finally {
		mock.timers.reset();
		emit("session_shutdown");
	}
	assert.deepEqual(warnings, []);
});

test("real assistant boxes in Pi's streaming order, empty or aborted, never trigger the Pi-changed warning", { skip }, () => {
	const handlers = {};
	ext.default({
		on: (name, handler) => (handlers[name] ??= []).push(handler),
		registerCommand() {},
	});
	const warnings = [];
	const sessionManager = { getEntries: () => [], getEntryCount: () => 0, getEntry: () => undefined };
	const ui = { notify: (message, type) => warnings.push({ message, type }), setStatus() {} };
	const emit = (name) => {
		for (const handler of handlers[name] ?? []) handler({ type: name }, { sessionManager, ui, hasUI: true });
	};
	emit("session_start");
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		const boxes = [
			new pi.AssistantMessageComponent(), // rendered before updateContent(): no lines
			new pi.AssistantMessageComponent({ role: "assistant", content: [], stopReason: "aborted", timestamp: MS }),
			new pi.AssistantMessageComponent({ role: "assistant", content: [], stopReason: "error", errorMessage: "boom", timestamp: MS }),
			new pi.AssistantMessageComponent({ role: "assistant", content: [], stopReason: "stop", timestamp: MS }),
		];
		for (let i = 0; i < 3; i++) {
			const streaming = new pi.AssistantMessageComponent();
			streaming.updateContent(assistantMessage("", Date.now()), true); // Pi's message_start order
			boxes.push(streaming);
		}
		for (let step = 0; step < 30; step++) {
			for (const box of boxes) box.render(WIDTH);
			mock.timers.tick(10_000);
		}
	} finally {
		mock.timers.reset();
		emit("session_shutdown");
	}
	assert.deepEqual(warnings, []);
});
