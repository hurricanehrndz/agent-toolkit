import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

import {
	composeFooterLine,
	getSessionCost,
	getSessionUsageStats,
	renderCacheUsage,
	renderContextUsage,
} from "./renderers.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

function messageEntry(id: string, message: AssistantMessage | UserMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-05T00:00:00.000Z",
		message,
	};
}

function assistantMessage({
	cost,
	input = 0,
	cacheRead = 0,
	cacheWrite = 0,
}: {
	cost: number;
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input,
			output: 0,
			cacheRead,
			cacheWrite,
			totalTokens: input + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("session usage", () => {
	test("adds the cost of every assistant response and ignores other messages", () => {
		const entries = [
			messageEntry("first", assistantMessage({ cost: 0.012 })),
			messageEntry("user", { role: "user", content: "continue", timestamp: 0 }),
			messageEntry("second", assistantMessage({ cost: 0.034 })),
		];

		assert.ok(Math.abs(getSessionCost(entries) - 0.046) < 0.005);
	});

	test("adds cache tokens and uses the latest turn for the hit rate", () => {
		const entries = [
			messageEntry(
				"first",
				assistantMessage({ cost: 0.012, input: 100, cacheRead: 900, cacheWrite: 100 }),
			),
			messageEntry(
				"second",
				assistantMessage({ cost: 0.034, input: 100, cacheRead: 300, cacheWrite: 100 }),
			),
		];

		assert.deepEqual(getSessionUsageStats(entries), {
			cost: 0.046,
			cacheRead: 1200,
			cacheWrite: 200,
			cacheHitRate: 60,
		});
	});
});

describe("usage rendering", () => {
	test("uses Pi's compact cache labels", () => {
		const stats = {
			cost: 0.046,
			cacheRead: 1200,
			cacheWrite: 200,
			cacheHitRate: 60,
		};

		assert.deepEqual(renderCacheUsage(stats, theme), {
			text: "R1.2k W200 CH60.0%",
			rawWidth: 18,
		});
	});

	test("hides cache stats when the session has no cache activity", () => {
		assert.deepEqual(renderCacheUsage(
				{ cost: 0, cacheRead: 0, cacheWrite: 0, cacheHitRate: 0 },
				theme,
			), { text: "", rawWidth: 0 });
	});

	test("shows unknown context after compaction", () => {
		assert.deepEqual(renderContextUsage(null, 200_000, theme), {
			text: "?/200k",
			rawWidth: 6,
		});
	});
});

describe("composeFooterLine", () => {
	test("pads between groups so the cache stats end at the right edge", () => {
		const line = composeFooterLine("left", "right", " | ", 20);

		assert.equal(line.length, 20);
		assert.equal(line.startsWith("left | "), true);
		assert.equal(line.endsWith("right"), true);
	});

	test("does not add a trailing separator when cache stats are absent", () => {
		assert.equal(composeFooterLine("left", "", " | ", 20), "left");
	});
});
