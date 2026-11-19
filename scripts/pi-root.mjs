// Locate the real Pi packages for the checks that run against them (typecheck, contract test).
// Nothing machine-specific is written to the repository: the location is found at run time.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
export const SKIP_REASON = "Pi packages not found (set GENTLE_TIMESTAMPS_PI_ROOT)";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const hasPi = (dir) => PI_PACKAGES.every((name) => existsSync(join(dir, name, "package.json")));

function globalRoot() {
	try {
		return execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined; // no npm on PATH
	}
}

/**
 * The absolute `node_modules` directory holding both Pi packages, or undefined.
 * Order: $GENTLE_TIMESTAMPS_PI_ROOT, <repo>/node_modules, <npm root -g>/gentle-pi/node_modules, <npm root -g>.
 * `npm root -g` is only run when the first two miss. `env` and `npmRoot` are injectable for checks.
 */
export function findPiRoot(env = process.env, npmRoot = globalRoot) {
	const local = [env.GENTLE_TIMESTAMPS_PI_ROOT, join(repoRoot, "node_modules")];
	for (const dir of local) if (dir && hasPi(dir)) return resolve(dir);
	const global = npmRoot();
	if (!global) return undefined;
	for (const dir of [join(global, "gentle-pi", "node_modules"), global]) if (hasPi(dir)) return resolve(dir);
	return undefined;
}
