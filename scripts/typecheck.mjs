// Typecheck gentle-timestamps.ts against the real Pi type declarations.
// Usage: npm run typecheck   (skips with exit 0 when Pi is not installed)
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPiRoot, PI_PACKAGES, SKIP_REASON } from "./pi-root.mjs";

// TypeScript is a devDependency: a clone without `npm install` gets one clear line, not a stack trace.
const NEEDS_INSTALL = "typecheck needs the devDependencies: run npm install";
/** @type {typeof import("typescript") | undefined} */
let ts;
try {
	ts = (await import("typescript")).default;
} catch (error) {
	if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = {
	getCanonicalFileName: (name) => name,
	getCurrentDirectory: () => repoRoot,
	getNewLine: () => "\n",
};
const report = (diagnostics) => console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));

/** Exit code: 0 clean or skipped, 1 on type or configuration errors. `findRoot` is injectable for checks. */
export function typecheck(findRoot = findPiRoot) {
	const piRoot = findRoot();
	if (!piRoot) {
		console.log(`typecheck skipped: ${SKIP_REASON}`);
		return 0;
	}
	if (!ts) {
		console.error(NEEDS_INSTALL);
		return 1;
	}
	const configFile = join(repoRoot, "tsconfig.json");
	const read = ts.readConfigFile(configFile, ts.sys.readFile);
	if (read.error) {
		report([read.error]);
		return 1;
	}
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot, undefined, configFile);
	const options = {
		...parsed.options,
		// The Pi location is machine-specific, so it is mapped here instead of in tsconfig.json.
		paths: Object.fromEntries(PI_PACKAGES.map((name) => [name, [join(piRoot, name)]])),
	};
	const program = ts.createProgram(parsed.fileNames, options);
	const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
	if (diagnostics.length > 0) {
		report(diagnostics);
		console.error(`typecheck failed: ${diagnostics.length} error(s) against Pi at ${piRoot}`);
		return 1;
	}
	console.log(`typecheck passed against Pi at ${piRoot}`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(typecheck());
