import { describe, expect, it } from "vitest";
import { normalizeProjectEditor } from "../projectPersistence";
import { applyAutomationOps, AutomationOpError, type AutomationEditorState } from "./automationOps";
import { buildTimelineView, projectTranscript } from "./automationView";

const ctx = { sourceDurationMs: 10_000 };

function baseState(overrides: Partial<AutomationEditorState> = {}): AutomationEditorState {
	return normalizeProjectEditor({
		clipRegions: [{ id: "clip-1", startMs: 0, endMs: 10_000, speed: 1 }],
		...overrides,
	});
}

describe("applyAutomationOps", () => {
	it("cuts a range out of the middle and ripples later regions", () => {
		const state = baseState({
			zoomRegions: [
				{ id: "zoom-1", startMs: 6000, endMs: 8000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
			],
		});
		const {
			state: next,
			results,
			changedKeys,
		} = applyAutomationOps(state, [{ op: "cut_range", startMs: 2000, endMs: 4000 }], ctx);
		expect(next.clipRegions.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
			[0, 2000],
			[2000, 8000],
		]);
		expect(next.clipRegions[1].sourceStartMs).toBe(4000);
		expect(next.zoomRegions[0]).toMatchObject({ startMs: 4000, endMs: 6000 });
		expect(results[0].removedIds).toHaveLength(1);
		expect(changedKeys).toEqual(expect.arrayContaining(["clipRegions", "zoomRegions"]));
	});

	it("drops regions that only covered cut footage", () => {
		const state = baseState({
			zoomRegions: [
				{ id: "zoom-1", startMs: 2500, endMs: 3500, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
			],
		});
		const { state: next } = applyAutomationOps(
			state,
			[{ op: "cut_range", startMs: 2000, endMs: 4000 }],
			ctx,
		);
		expect(next.zoomRegions).toEqual([]);
	});

	it("applies several cuts in one batch using the updated timeline", () => {
		const { state: next } = applyAutomationOps(
			baseState(),
			[
				{ op: "cut_range", startMs: 0, endMs: 1000 },
				{ op: "cut_range", startMs: 8000, endMs: 9000 },
			],
			ctx,
		);
		expect(next.clipRegions.reduce((sum, clip) => sum + clip.endMs - clip.startMs, 0)).toBe(
			8000,
		);
	});

	it("changes the speed of a range and shortens the timeline", () => {
		const { state: next } = applyAutomationOps(
			baseState(),
			[{ op: "set_speed_range", startMs: 2000, endMs: 6000, speed: 2 }],
			ctx,
		);
		const view = buildTimelineView(next, ctx.sourceDurationMs);
		expect(view.timelineDurationMs).toBe(8000);
		expect(view.clips.map((clip) => clip.speed)).toEqual([1, 2, 1]);
		expect(view.clips[2]).toMatchObject({ startMs: 4000, sourceStartMs: 6000 });
	});

	it("rejects the whole batch when one op is invalid", () => {
		const state = baseState();
		expect(() =>
			applyAutomationOps(
				state,
				[
					{ op: "add_zoom", startMs: 1000, endMs: 2000 },
					{ op: "add_zoom", startMs: 1500, endMs: 2500 },
				],
				ctx,
			),
		).toThrowError(AutomationOpError);
		expect(state.zoomRegions).toEqual([]);
	});

	it("names the failing op", () => {
		try {
			applyAutomationOps(baseState(), [{ op: "delete_zoom", id: "zoom-9" }], ctx);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(AutomationOpError);
			expect((error as AutomationOpError).index).toBe(0);
			expect((error as Error).message).toContain("no zoom with id zoom-9");
		}
	});

	it("adds a manual zoom when a focus point is given", () => {
		const { state: next, results } = applyAutomationOps(
			baseState(),
			[{ op: "add_zoom", startMs: 1000, endMs: 3000, depth: 4, focus: { cx: 0.2, cy: 0.3 } }],
			ctx,
		);
		expect(next.zoomRegions[0]).toMatchObject({
			id: "zoom-1",
			depth: 4,
			mode: "manual",
			focus: { cx: 0.2, cy: 0.3 },
		});
		expect(results[0].createdIds).toEqual(["zoom-1"]);
	});

	it("adds text annotations with defaults", () => {
		const { state: next } = applyAutomationOps(
			baseState(),
			[{ op: "add_annotation", startMs: 0, endMs: 2000, text: "Hello" }],
			ctx,
		);
		expect(next.annotationRegions[0]).toMatchObject({
			type: "text",
			content: "Hello",
			textContent: "Hello",
			zIndex: 1,
		});
	});

	it("stores captions in recording time and enables captions", () => {
		const cut = applyAutomationOps(
			baseState(),
			[{ op: "cut_range", startMs: 0, endMs: 2000 }],
			ctx,
		).state;
		const { state: next } = applyAutomationOps(
			cut,
			[{ op: "add_caption", startMs: 1000, endMs: 2000, text: "hi there" }],
			ctx,
		);
		expect(next.autoCaptions[0]).toMatchObject({ startMs: 3000, endMs: 4000 });
		expect(next.autoCaptionSettings.enabled).toBe(true);
		expect(buildTimelineView(next, ctx.sourceDurationMs).captions[0]).toMatchObject({
			startMs: 1000,
			endMs: 2000,
			text: "hi there",
		});
	});

	it("only accepts allow-listed appearance settings", () => {
		const { state: next } = applyAutomationOps(
			baseState(),
			[{ op: "set_appearance", settings: { showCursor: false, padding: { top: 40 } } }],
			ctx,
		);
		expect(next.showCursor).toBe(false);
		expect(next.padding).toMatchObject({ top: 40, bottom: 40, left: 40, right: 40 });
		expect(() =>
			applyAutomationOps(
				baseState(),
				[{ op: "set_appearance", settings: { clipRegions: [] } }],
				ctx,
			),
		).toThrowError(/unknown appearance setting/);
	});

	it("validates aspect ratio and crop", () => {
		const { state: next } = applyAutomationOps(
			baseState(),
			[
				{ op: "set_aspect_ratio", aspectRatio: "9:16" },
				{ op: "set_crop", x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
			],
			ctx,
		);
		expect(next.aspectRatio).toBe("9:16");
		expect(next.cropRegion).toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
		expect(() =>
			applyAutomationOps(
				baseState(),
				[{ op: "set_crop", x: 0.5, y: 0, width: 0.8, height: 1 }],
				ctx,
			),
		).toThrowError(/inside the frame/);
	});

	it("does not rewrite untouched keys", () => {
		const state = baseState();
		const { state: next, changedKeys } = applyAutomationOps(
			state,
			[{ op: "set_aspect_ratio", aspectRatio: "1:1" }],
			ctx,
		);
		expect(changedKeys).toEqual(["aspectRatio"]);
		expect(next.clipRegions).toBe(state.clipRegions);
	});
});

describe("projectTranscript", () => {
	it("maps words to the timeline and marks cut words", () => {
		const state = applyAutomationOps(
			baseState(),
			[{ op: "cut_range", startMs: 1000, endMs: 2000 }],
			ctx,
		).state;
		const [segment] = projectTranscript(
			[
				{
					id: "cue-1",
					startMs: 500,
					endMs: 2500,
					text: "so um hello",
					words: [
						{ text: "so", startMs: 500, endMs: 900 },
						{ text: "um", startMs: 1200, endMs: 1600, leadingSpace: true },
						{ text: "hello", startMs: 2100, endMs: 2500, leadingSpace: true },
					],
				},
			],
			state.clipRegions,
		);
		expect(segment.words.map((word) => [word.text, word.startMs])).toEqual([
			["so", 500],
			["um", null],
			["hello", 1100],
		]);
		expect(segment).toMatchObject({ startMs: 500, endMs: 1500 });
	});
});

describe("motion presets", () => {
	it("applies a whole motion preset at once", () => {
		const { state: next } = applyAutomationOps(
			baseState(),
			[{ op: "set_appearance", settings: { motionPreset: "smooth" } }],
			ctx,
		);
		expect(buildTimelineView(next, ctx.sourceDurationMs).appearance.motionPreset).toBe(
			"smooth",
		);
	});

	it("rejects raw values the project format cannot keep", () => {
		expect(() =>
			applyAutomationOps(
				baseState(),
				[{ op: "set_appearance", settings: { cursorSize: 4 } }],
				ctx,
			),
		).toThrowError(/unknown appearance setting cursorSize/);
	});
});
