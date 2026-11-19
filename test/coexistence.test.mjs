// Does a foreign, silenced stamp wrapper leave the padding line blank enough for
// gentle-timestamps' wrapper to still paint? Reproduces that wrapper's exact rewrite with
// an empty stamp and checks both stacking orders.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GENTLE_TIMESTAMPS_CONFIG = join(mkdtempSync(join(tmpdir(), "timestamps-coexist-")), "ext.json");
const ext = await import("../gentle-timestamps.ts");
const pi = await import("@earendil-works/pi-coding-agent");

ext.writeConfig({ ...ext.DEFAULTS, format: "%H:%M", formatOlder: null });
ext.syncConfig();

const BG = "\x1b[48;2;40;40;40m";
const RESET_BG = "\x1b[49m";
const strip = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const box = (w) => [BG + " ".repeat(w) + RESET_BG, " content ", BG + " ".repeat(w) + RESET_BG];
const WIDTH = 40;

/** A foreign stamp wrapper's geometry, with its stamp forced to "" (silenced). */
installSilencedWrapper(pi.AssistantMessageComponent);

function installSilencedWrapper(C) {
	const orig = C.prototype.render;
	C.prototype.render = function (width) {
		const lines = [...orig.call(this, width)];
		const STAMP = "";
		const blank = (l) => l !== undefined && strip(l).trim() === "";
		const hasBg = (l) => l !== undefined && /\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/.test(l);
		let i = -1;
		if (blank(lines[0]) && hasBg(lines[0])) i = 0;
		else if (blank(lines[0]) && blank(lines[1]) && hasBg(lines[1])) i = 1;
		else if (blank(lines[0])) i = 0;
		if (i < 0) return lines;
		if (width < STAMP.length + 1) return lines;
		const bgCode = lines[i].match(/\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/)?.[0];
		const bg = bgCode ? (s) => `${bgCode}${s}\x1b[49m` : undefined;
		const body = " ".repeat(width - STAMP.length - 1) + `\x1b[2m${STAMP}\x1b[39;22m `;
		lines[i] = bg ? bg(body) : body;
		return lines;
	};
}

test("gentle-timestamps still paints when a silenced foreign wrapper runs first", () => {
	const component = new pi.AssistantMessageComponent(box(WIDTH), Date.now());
	const lines = component.render(WIDTH);
	const stamp = strip(lines[0]).trim();
	assert.notEqual(stamp, "", "the padding line came back empty: the silenced wrapper swallowed the stamp");
	assert.equal(strip(lines[1]), " content ");
});

test("the silenced wrapper leaves an invisible, blank padding line", () => {
	const C = class extends pi.AssistantMessageComponent {};
	// Render with gentle-timestamps temporarily off to isolate the foreign wrapper's own output.
	ext.writeConfig({ ...ext.DEFAULTS, enabled: false });
	ext.syncConfig();
	const lines = new pi.AssistantMessageComponent(box(WIDTH), Date.now()).render(WIDTH);
	assert.equal(strip(lines[0]).trim(), "");
	assert.equal(strip(lines[0]).length, WIDTH);
	assert.equal(lines[0].includes(BG), true);
	ext.writeConfig({ ...ext.DEFAULTS });
	ext.syncConfig();
	assert.ok(C);
});
