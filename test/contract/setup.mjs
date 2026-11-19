// Resolve Pi's packages to the real installed ones (see scripts/pi-root.mjs), so the contract
// tests exercise the extension against real Pi objects. Without Pi nothing is mapped and the
// tests skip.
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findPiRoot, PI_PACKAGES } from "../../scripts/pi-root.mjs";

export const piRoot = findPiRoot();

if (piRoot) {
	// Resolving as if imported from a file next to the packages lets Node pick each package's
	// own entry file (`exports` or `main`).
	const parentURL = pathToFileURL(join(piRoot, "gentle-timestamps-contract.mjs")).href;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			return PI_PACKAGES.includes(specifier)
				? nextResolve(specifier, { ...context, parentURL })
				: nextResolve(specifier, context);
		},
	});
}
