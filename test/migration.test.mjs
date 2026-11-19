// Upgrading from gentle-when: its when.json becomes timestamps.json once, and is never touched.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "timestamps-migration-"));
after(() => rmSync(root, { recursive: true, force: true }));
// The module-load migration must not touch the real home: an explicit path disables it.
process.env.GENTLE_TIMESTAMPS_CONFIG = join(root, "loaded.json");
const ext = await import("../gentle-timestamps.ts");

let n = 0;
const home = () => mkdtempSync(join(root, `home-${n++}-`));

test("a legacy when.json becomes timestamps.json with the new schema; when.json is left byte-identical", () => {
	const dir = home();
	const legacy = join(dir, "when.json");
	const body = JSON.stringify({ schema: "gentle-pi.when/v1", enabled: false, format: "%T", formatOlder: null, style: "block" });
	writeFileSync(legacy, body, "utf8");
	ext.migrateLegacyConfig({ GENTLE_PI_CONFIG_HOME: dir });
	const migrated = JSON.parse(readFileSync(join(dir, "timestamps.json"), "utf8"));
	assert.deepEqual(migrated, { schema: "gentle-timestamps/v1", enabled: false, format: "%T", formatOlder: null, style: "block" });
	assert.equal(readFileSync(legacy, "utf8"), body);
});

test("an existing timestamps.json is never overwritten", () => {
	const dir = home();
	writeFileSync(join(dir, "when.json"), JSON.stringify({ format: "%T" }), "utf8");
	const current = JSON.stringify({ format: "%H:%M" });
	writeFileSync(join(dir, "timestamps.json"), current, "utf8");
	ext.migrateLegacyConfig({ GENTLE_PI_CONFIG_HOME: dir });
	assert.equal(readFileSync(join(dir, "timestamps.json"), "utf8"), current);
});

test("a malformed legacy file migrates nothing, and does not throw", () => {
	const dir = home();
	writeFileSync(join(dir, "when.json"), "{not json", "utf8");
	assert.doesNotThrow(() => ext.migrateLegacyConfig({ GENTLE_PI_CONFIG_HOME: dir }));
	assert.equal(existsSync(join(dir, "timestamps.json")), false);
	assert.equal(readFileSync(join(dir, "when.json"), "utf8"), "{not json");
});

test("an explicit GENTLE_TIMESTAMPS_CONFIG disables the migration", () => {
	const dir = home();
	writeFileSync(join(dir, "when.json"), JSON.stringify({ format: "%T" }), "utf8");
	const explicit = join(dir, "explicit.json");
	ext.migrateLegacyConfig({ GENTLE_PI_CONFIG_HOME: dir, GENTLE_TIMESTAMPS_CONFIG: explicit });
	assert.equal(existsSync(join(dir, "timestamps.json")), false);
	assert.equal(existsSync(explicit), false);
});
