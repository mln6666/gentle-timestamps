// Minimal stand-ins for the three Pi components the extension wraps.
// render(width) returns the lines the real component would produce (a fresh
// array, as Pi's Container does); the patch is expected to repaint only the
// blank top padding line. Extra fields mirror the real instance fields the
// extension reads (messageId, timestamp, toolCallId, lastMessage).

class StubComponent {
	constructor(lines, fields = {}) {
		this.lines = lines;
		Object.assign(this, fields);
	}
	render(_width) {
		return this.lines.slice();
	}
}

export class AssistantMessageComponent extends StubComponent {
	constructor(lines, timestamp, fields = {}) {
		super(lines, fields);
		if (timestamp !== undefined) this.lastMessage = { timestamp };
	}
}

export class UserMessageComponent extends StubComponent {}

export class ToolExecutionComponent extends StubComponent {}
