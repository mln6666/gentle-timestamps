// Copy gentle-timestamps.ts into the Gentle Shell extensions folder (atomic replace), then remove
// the legacy gentle-when.ts (the former name) so the command is not registered twice.
// Usage: npm run install-extension [-- <extensions-dir>]
// Default dir: $GENTLE_TIMESTAMPS_EXTENSIONS_DIR or ~/.gentle-shell/agent/extensions
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..", "gentle-timestamps.ts");
const dir = process.argv[2] || process.env.GENTLE_TIMESTAMPS_EXTENSIONS_DIR || join(homedir(), ".gentle-shell", "agent", "extensions");
const target = join(dir, "gentle-timestamps.ts");
const legacy = join(dir, "gentle-when.ts");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);

mkdirSync(dir, { recursive: true });
const tmp = `${target}.${process.pid}.tmp`;
copyFileSync(source, tmp);
renameSync(tmp, target);
if (sha(source) !== sha(target)) throw new Error(`install verification failed: ${target}`);
console.log(`installed ${target} (sha256 ${sha(target)})`);
if (existsSync(legacy)) {
	unlinkSync(legacy);
	console.log(`removed legacy ${legacy}`);
}
console.log("Restart Gentle Shell (or run /reload) to load it.");
