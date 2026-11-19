// A process that ran gentle-when keeps its render shim after /reload. Loading gentle-timestamps
// must silence it, so each box shows one stamp, not two.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "timestamps-legacy-shim-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.GENTLE_TIMESTAMPS_CONFIG = join(dir, "timestamps.json");

const pi = await import("@earendil-works/pi-coding-agent");

const BG = "\x1b[48;2;40;40;40m";
const RESET_BG = "\x1b[49m";
const plain = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const WIDTH = 40;
const box = () => [BG + " ".repeat(WIDTH) + RESET_BG, " content ", BG + " ".repeat(WIDTH) + RESET_BG];

// The legacy state and shim, as gentle-when left them.
const LEGACY_KEY = Symbol.for("gentle-when.v2");
const legacyTimer = setInterval(() => {}, 60_000);
legacyTimer.unref();
after(() => clearInterval(legacyTimer));
const legacy = (globalThis[LEGACY_KEY] = {
	timer: legacyTimer,
	decorate: (_component, lines, width) => {
		const out = lines.slice();
		out[0] = BG + " ".repeat(width - 4) + "OLD " + RESET_BG;
		return out;
	},
});
const original = pi.AssistantMessageComponent.prototype.render;
pi.AssistantMessageComponent.prototype.render = function (width) {
	const lines = original.call(this, width);
	const current = globalThis[LEGACY_KEY]?.decorate;
	if (!current) return lines;
	return current(this, lines, width);
};

const ext = await import("../gentle-timestamps.ts");
ext.writeConfig({ ...ext.DEFAULTS, format: "%H:%M", formatOlder: null });
ext.syncConfig();

test("the legacy shim passes lines through and only the new stamp is painted", () => {
	const ms = new Date(2026, 10, 14, 14, 32).getTime();
	const lines = new pi.AssistantMessageComponent(box(), ms).render(WIDTH);
	assert.equal(plain(lines[0]).trim(), ext.strftime(new Date(ms), "%H:%M"));
	assert.equal(lines[0].includes("OLD"), false);
});

test("the legacy state's decorate and refresh timer are cleared", () => {
	assert.equal(legacy.decorate, undefined);
	assert.equal(legacy.timer, undefined);
});
