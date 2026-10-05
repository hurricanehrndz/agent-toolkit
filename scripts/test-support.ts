import assert from "node:assert/strict";

export function assertIncludes(actual: string | readonly string[], expected: string, message?: string): void {
	assert.ok(
		actual.includes(expected),
		message ?? `expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`,
	);
}

export function assertExcludes(actual: string | readonly string[], expected: string, message?: string): void {
	assert.ok(
		!actual.includes(expected),
		message ?? `expected ${JSON.stringify(actual)} not to include ${JSON.stringify(expected)}`,
	);
}
