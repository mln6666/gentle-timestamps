// Resolve Pi's packages to local stand-ins, so the suite runs without Pi installed.
import { registerHooks } from "node:module";

const STUBS = {
	"@earendil-works/pi-coding-agent": new URL("./stub/pi-coding-agent/index.mjs", import.meta.url).href,
	"@earendil-works/pi-tui": new URL("./stub/pi-tui/index.mjs", import.meta.url).href,
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = STUBS[specifier];
		return url ? { url, format: "module", shortCircuit: true } : nextResolve(specifier, context);
	},
});
