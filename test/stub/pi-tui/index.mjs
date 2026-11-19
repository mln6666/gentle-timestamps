// Stand-in for @earendil-works/pi-tui's column measure: ANSI sequences are
// zero-width, East Asian wide characters and emoji take two columns.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

export function visibleWidth(text) {
	let width = 0;
	for (const ch of text.replace(ANSI, "")) width += WIDE.test(ch) ? 2 : 1;
	return width;
}
