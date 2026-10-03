/**
 * Pure edit operations for the local automation API (Claude / MCP control).
 *
 * Every operation takes timeline milliseconds — the times the user sees in the
 * editor — and reuses the same sequence helpers as the timeline UI so that an
 * automated edit ripples exactly like a manual one. A batch is atomic: if any
 * op is invalid, none of the batch is applied.
 */
import { ASPECT_RATIOS, type AspectRatio, isCustomAspectRatio } from "@/utils/aspectRatioUtils";
import { addCue, createCaptionCue, deleteCue, retimeCue } from "../captionOps";
import { packClipSequence, rippleRegionAnchors, rippleRegions } from "../clipSequence";
import { planClipSplit } from "../clipSplit";
import { CURSOR_MOTION_PRESETS, type CursorMotionPresetId } from "../cursorMotionPresets";
import {
	deriveNextId,
	normalizeProjectEditor,
	type ProjectEditorState,
} from "../projectPersistence";
import {
	type AnnotationRegion,
	type AudioRegion,
	type AutoCaptionSettings,
	type ClipRegion,
	type CropRegion,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_FIGURE_DATA,
	DEFAULT_ZOOM_DEPTH,
	getClipSourceStartMs,
	getTimelineDurationMs,
	mapTimelineTimeToSourceTime,
	sortClipRegions,
	type ZoomDepth,
	type ZoomRegion,
} from "../types";

export type AutomationEditorState = ProjectEditorState;

export interface AutomationContext {
	/** Duration of the loaded recording, in milliseconds. */
	sourceDurationMs: number;
	/** Whether the preview can play a clip at this speed (renderer-only check). */
	isSupportedClipSpeed?: (speed: number) => boolean;
}

type Span = { startMs: number; endMs: number };
type Focus = { cx: number; cy: number };

export type AutomationOp =
	| ({ op: "cut_range" } & Span)
	| { op: "split_clip"; atMs: number }
	| { op: "delete_clip"; id: string }
	| { op: "set_clip_speed"; id: string; speed: number }
	| ({ op: "set_speed_range"; speed: number } & Span)
	| { op: "set_clip_muted"; id: string; muted: boolean }
	| ({ op: "add_zoom"; depth?: number; focus?: Focus; mode?: "auto" | "manual" } & Span)
	| {
			op: "update_zoom";
			id: string;
			startMs?: number;
			endMs?: number;
			depth?: number;
			focus?: Focus;
			mode?: "auto" | "manual";
	  }
	| { op: "delete_zoom"; id: string }
	| ({ op: "add_annotation" } & Span & AnnotationFields)
	| ({ op: "update_annotation"; id: string; startMs?: number; endMs?: number } & AnnotationFields)
	| { op: "delete_annotation"; id: string }
	| ({ op: "add_caption"; text: string } & Span)
	| { op: "edit_caption"; id: string; text?: string; startMs?: number; endMs?: number }
	| { op: "delete_caption"; id: string }
	| { op: "clear_captions" }
	| { op: "set_caption_settings"; settings: Partial<AutoCaptionSettings> }
	| { op: "set_appearance"; settings: Record<string, unknown> }
	| ({ op: "set_crop" } & CropRegion)
	| { op: "set_aspect_ratio"; aspectRatio: string }
	| ({ op: "add_audio"; path: string; volume?: number; trackIndex?: number } & Span)
	| {
			op: "update_audio";
			id: string;
			startMs?: number;
			endMs?: number;
			volume?: number;
			normalize?: boolean;
	  }
	| { op: "delete_audio"; id: string };

export type AutomationOpName = AutomationOp["op"];

interface AnnotationFields {
	type?: "text" | "figure" | "blur";
	text?: string;
	position?: { x: number; y: number };
	size?: { width: number; height: number };
	style?: Partial<AnnotationRegion["style"]>;
	figure?: Partial<NonNullable<AnnotationRegion["figureData"]>>;
	blurIntensity?: number;
	blurColor?: string;
	trackIndex?: number;
}

export interface AutomationOpResult {
	op: AutomationOpName;
	/** Ids of regions created by the op (clips, zooms, annotations, captions, audio). */
	createdIds?: string[];
	/** Ids removed by the op. */
	removedIds?: string[];
}

export interface AutomationOpsOutcome {
	state: AutomationEditorState;
	results: AutomationOpResult[];
	/** Top-level editor keys whose value changed, for the caller to push into React state. */
	changedKeys: Array<keyof AutomationEditorState>;
}

export class AutomationOpError extends Error {
	constructor(
		readonly index: number,
		readonly op: string,
		message: string,
	) {
		super(`ops[${index}] (${op}): ${message}`);
		this.name = "AutomationOpError";
	}
}

/**
 * Appearance keys the API may change, with the value type each must have.
 * Cursor size/smoothing/bounce and zoom durations are not listed: the project
 * format only keeps them as one of the motion presets, so they are set together
 * through the `motionPreset` setting instead.
 */
export const AUTOMATION_APPEARANCE_KEYS = {
	wallpaper: "string",
	shadowIntensity: "number",
	backgroundBlur: "number",
	borderRadius: "number",
	padding: "object",
	zoomMotionBlur: "number",
	connectZooms: "boolean",
	zoomInOverlapMs: "number",
	connectedZoomGapMs: "number",
	connectedZoomDurationMs: "number",
	zoomInEasing: "string",
	zoomOutEasing: "string",
	connectedZoomEasing: "string",
	zoomClassicMode: "boolean",
	showCursor: "boolean",
	loopCursor: "boolean",
	cursorStyle: "string",
	cursorClickEffect: "string",
	cursorClickEffectColor: "string",
	cursorClickEffectScale: "number",
	cursorClickEffectOpacity: "number",
	cursorClickEffectDurationMs: "number",
	cursorSway: "number",
	webcam: "object",
} as const satisfies Partial<
	Record<keyof ProjectEditorState, "string" | "number" | "boolean" | "object">
>;

const ZOOM_EASINGS = new Set(["recordly", "glide", "smooth", "snappy", "linear"]);
const MIN_CLIP_SPEED = 0.25;
const MAX_CLIP_SPEED = 16;

class OpFailure extends Error {}

function fail(message: string): never {
	throw new OpFailure(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireFinite(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be a number`);
	return value;
}

function optionalFinite(value: unknown, name: string): number | undefined {
	return value === undefined ? undefined : requireFinite(value, name);
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty string`);
	return value;
}

function requireUnit(value: unknown, name: string): number {
	const number = requireFinite(value, name);
	if (number < 0 || number > 1) fail(`${name} must be between 0 and 1`);
	return number;
}

function requireSpan(startMs: unknown, endMs: unknown, maxMs?: number): Span {
	const start = Math.round(requireFinite(startMs, "startMs"));
	const end = Math.round(requireFinite(endMs, "endMs"));
	if (start < 0) fail("startMs must be >= 0");
	if (end <= start) fail("endMs must be greater than startMs");
	if (maxMs !== undefined && start >= maxMs) {
		fail(`startMs ${start} is past the end of the timeline (${maxMs}ms)`);
	}
	return { startMs: start, endMs: maxMs !== undefined ? Math.min(end, maxMs) : end };
}

function requireClip(clips: ClipRegion[], id: unknown): ClipRegion {
	const clip = clips.find((candidate) => candidate.id === id);
	if (!clip) fail(`no clip with id ${String(id)}`);
	return clip;
}

function findById<T extends { id: string }>(items: T[], id: unknown, label: string): T {
	const item = items.find((candidate) => candidate.id === id);
	if (!item) fail(`no ${label} with id ${String(id)}`);
	return item;
}

function requireSpeed(value: unknown, ctx: AutomationContext): number {
	const speed = requireFinite(value, "speed");
	if (speed < MIN_CLIP_SPEED || speed > MAX_CLIP_SPEED) {
		fail(`speed must be between ${MIN_CLIP_SPEED} and ${MAX_CLIP_SPEED}`);
	}
	if (Math.abs(speed * 4 - Math.round(speed * 4)) > 1e-9) {
		fail("speed must be a multiple of 0.25");
	}
	if (ctx.isSupportedClipSpeed && !ctx.isSupportedClipSpeed(speed)) {
		fail(`speed ${speed} is not supported for preview on this device`);
	}
	return speed;
}

function requireZoomDepth(value: unknown): ZoomDepth {
	const depth = requireFinite(value, "depth");
	if (!Number.isInteger(depth) || depth < 1 || depth > 6) {
		fail("depth must be an integer from 1 (subtle) to 6 (strongest)");
	}
	return depth as ZoomDepth;
}

function requireFocus(value: unknown): Focus {
	if (!isRecord(value)) fail("focus must be an object { cx, cy }");
	return { cx: requireUnit(value.cx, "focus.cx"), cy: requireUnit(value.cy, "focus.cy") };
}

function nextId(prefix: string, items: Array<{ id: string }>): string {
	return `${prefix}-${deriveNextId(
		prefix,
		items.map(({ id }) => id),
	)}`;
}

function timelineDurationMs(state: AutomationEditorState, ctx: AutomationContext): number {
	return getTimelineDurationMs(state.clipRegions, ctx.sourceDurationMs);
}

function spansOverlap(left: Span, right: Span) {
	return left.startMs < right.endMs && left.endMs > right.startMs;
}

function assertNoZoomOverlap(zooms: ZoomRegion[], candidate: ZoomRegion) {
	const other = zooms.find((zoom) => zoom.id !== candidate.id && spansOverlap(zoom, candidate));
	if (other) {
		fail(
			`zoom would overlap ${other.id} (${other.startMs}-${other.endMs}ms); zoom regions cannot overlap`,
		);
	}
}

/** Re-pack the footage sequence and carry every timeline-anchored region with it. */
function applyClipSequence(
	state: AutomationEditorState,
	before: ClipRegion[],
	edited: ClipRegion[],
): AutomationEditorState {
	const after = packClipSequence(sortClipRegions(edited));
	return {
		...state,
		clipRegions: after,
		zoomRegions: rippleRegions(state.zoomRegions, before, after),
		annotationRegions: rippleRegions(state.annotationRegions, before, after),
		audioRegions: rippleRegionAnchors(state.audioRegions, before, after),
	};
}

/** Split the clip under `atMs` (if any). Returns the new clip list and created ids. */
function splitClipsAt(clips: ClipRegion[], atMs: number) {
	let created: string[] = [];
	const pool = [...clips];
	const plan = planClipSplit({
		clipRegions: clips,
		splitMs: atMs,
		createId: () => {
			const id = nextId("clip", pool);
			pool.push({ id, startMs: 0, endMs: 1, speed: 1 });
			return id;
		},
	});
	if (!plan) return { clips, created, removed: [] as string[] };
	created = [plan.left.id, plan.right.id];
	return {
		clips: clips.flatMap((clip) =>
			clip.id === plan.targetId ? [plan.left, plan.right] : [clip],
		),
		created,
		removed: [plan.targetId],
	};
}

function requireClips(state: AutomationEditorState) {
	if (state.clipRegions.length === 0) {
		fail("the timeline has no footage clips yet; wait for the recording to finish loading");
	}
}

function withClipSpeed(clip: ClipRegion, speed: number): ClipRegion {
	const oldSpeed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
	return {
		...clip,
		sourceStartMs: getClipSourceStartMs(clip),
		speed,
		endMs:
			clip.startMs +
			Math.max(1, Math.round(((clip.endMs - clip.startMs) * oldSpeed) / speed)),
	};
}

function buildAnnotation(base: AnnotationRegion, fields: AnnotationFields): AnnotationRegion {
	const next: AnnotationRegion = { ...base };
	if (fields.type !== undefined) {
		if (!["text", "figure", "blur"].includes(fields.type)) {
			fail("annotation type must be text, figure or blur");
		}
		next.type = fields.type;
	}
	if (fields.text !== undefined) {
		if (typeof fields.text !== "string") fail("text must be a string");
		next.content = fields.text;
		next.textContent = fields.text;
	}
	if (fields.position !== undefined) {
		if (!isRecord(fields.position)) fail("position must be { x, y } in percent");
		next.position = {
			x: Math.max(0, Math.min(100, requireFinite(fields.position.x, "position.x"))),
			y: Math.max(0, Math.min(100, requireFinite(fields.position.y, "position.y"))),
		};
	}
	if (fields.size !== undefined) {
		if (!isRecord(fields.size)) fail("size must be { width, height } in percent");
		next.size = {
			width: Math.max(1, Math.min(100, requireFinite(fields.size.width, "size.width"))),
			height: Math.max(1, Math.min(100, requireFinite(fields.size.height, "size.height"))),
		};
	}
	if (fields.style !== undefined) {
		if (!isRecord(fields.style)) fail("style must be an object");
		next.style = { ...next.style, ...fields.style };
		if (typeof next.style.fontSize !== "number" || !Number.isFinite(next.style.fontSize)) {
			fail("style.fontSize must be a number");
		}
	}
	if (fields.figure !== undefined) {
		if (!isRecord(fields.figure)) fail("figure must be an object");
		next.figureData = { ...DEFAULT_FIGURE_DATA, ...next.figureData, ...fields.figure };
	}
	if (fields.blurIntensity !== undefined) {
		next.blurIntensity = Math.max(1, requireFinite(fields.blurIntensity, "blurIntensity"));
	}
	if (fields.blurColor !== undefined) {
		next.blurColor = requireString(fields.blurColor, "blurColor");
	}
	if (fields.trackIndex !== undefined) {
		next.trackIndex = Math.max(0, Math.floor(requireFinite(fields.trackIndex, "trackIndex")));
	}
	if (next.type === "figure" && !next.figureData) next.figureData = { ...DEFAULT_FIGURE_DATA };
	return next;
}

function toSourceSpan(state: AutomationEditorState, span: Span): Span {
	if (state.clipRegions.length === 0) return span;
	const startMs = mapTimelineTimeToSourceTime(span.startMs, state.clipRegions);
	// Map the last included millisecond so a span ending exactly on a clip boundary
	// stays inside that clip's footage instead of jumping to the next clip's source.
	const endMs = mapTimelineTimeToSourceTime(span.endMs - 1, state.clipRegions) + 1;
	return { startMs, endMs: Math.max(startMs + 1, endMs) };
}

function applyOp(
	state: AutomationEditorState,
	op: AutomationOp,
	ctx: AutomationContext,
): { state: AutomationEditorState; result: AutomationOpResult } {
	const result: AutomationOpResult = { op: op.op };
	switch (op.op) {
		case "cut_range": {
			requireClips(state);
			const span = requireSpan(op.startMs, op.endMs, timelineDurationMs(state, ctx));
			const before = state.clipRegions;
			const atStart = splitClipsAt(before, span.startMs);
			const atEnd = splitClipsAt(atStart.clips, span.endMs);
			const split = atEnd.clips;
			const kept = split.filter(
				(clip) => clip.endMs <= span.startMs || clip.startMs >= span.endMs,
			);
			if (kept.length === split.length) fail("the range does not cover any footage");
			result.removedIds = split.filter((clip) => !kept.includes(clip)).map((clip) => clip.id);
			return {
				state: applyClipSequence({ ...state, clipRegions: split }, split, kept),
				result,
			};
		}
		case "split_clip": {
			requireClips(state);
			const atMs = Math.round(requireFinite(op.atMs, "atMs"));
			const split = splitClipsAt(state.clipRegions, atMs);
			if (split.created.length === 0) {
				fail(`${atMs}ms is not strictly inside a clip (it may already be a clip boundary)`);
			}
			result.createdIds = split.created;
			result.removedIds = split.removed;
			return { state: { ...state, clipRegions: split.clips }, result };
		}
		case "delete_clip": {
			const clip = requireClip(state.clipRegions, op.id);
			result.removedIds = [clip.id];
			return {
				state: applyClipSequence(
					state,
					state.clipRegions,
					state.clipRegions.filter((candidate) => candidate.id !== clip.id),
				),
				result,
			};
		}
		case "set_clip_speed": {
			const clip = requireClip(state.clipRegions, op.id);
			const speed = requireSpeed(op.speed, ctx);
			return {
				state: applyClipSequence(
					state,
					state.clipRegions,
					state.clipRegions.map((candidate) =>
						candidate.id === clip.id ? withClipSpeed(candidate, speed) : candidate,
					),
				),
				result,
			};
		}
		case "set_speed_range": {
			requireClips(state);
			const span = requireSpan(op.startMs, op.endMs, timelineDurationMs(state, ctx));
			const speed = requireSpeed(op.speed, ctx);
			const atStart = splitClipsAt(state.clipRegions, span.startMs);
			const atEnd = splitClipsAt(atStart.clips, span.endMs);
			const split = atEnd.clips;
			const inside = (clip: ClipRegion) =>
				clip.startMs >= span.startMs && clip.endMs <= span.endMs;
			if (!split.some(inside)) fail("the range does not cover any footage");
			result.createdIds = [...atStart.created, ...atEnd.created].filter((id) =>
				split.some((clip) => clip.id === id),
			);
			return {
				state: applyClipSequence(
					{ ...state, clipRegions: split },
					split,
					split.map((clip) => (inside(clip) ? withClipSpeed(clip, speed) : clip)),
				),
				result,
			};
		}
		case "set_clip_muted": {
			const clip = requireClip(state.clipRegions, op.id);
			if (typeof op.muted !== "boolean") fail("muted must be a boolean");
			return {
				state: {
					...state,
					clipRegions: state.clipRegions.map((candidate) =>
						candidate.id === clip.id ? { ...candidate, muted: op.muted } : candidate,
					),
				},
				result,
			};
		}
		case "add_zoom": {
			const span = requireSpan(op.startMs, op.endMs, timelineDurationMs(state, ctx));
			const depth = op.depth === undefined ? DEFAULT_ZOOM_DEPTH : requireZoomDepth(op.depth);
			const zoom: ZoomRegion = {
				id: nextId("zoom", state.zoomRegions),
				...span,
				depth,
				focus: op.focus === undefined ? { cx: 0.5, cy: 0.5 } : requireFocus(op.focus),
				// "auto" follows the cursor; "manual" holds the given focus point.
				mode: op.mode ?? (op.focus === undefined ? "auto" : "manual"),
			};
			if (zoom.mode !== "auto" && zoom.mode !== "manual") fail("mode must be auto or manual");
			assertNoZoomOverlap(state.zoomRegions, zoom);
			result.createdIds = [zoom.id];
			return { state: { ...state, zoomRegions: [...state.zoomRegions, zoom] }, result };
		}
		case "update_zoom": {
			const current = findById(state.zoomRegions, op.id, "zoom");
			const span = requireSpan(op.startMs ?? current.startMs, op.endMs ?? current.endMs);
			const zoom: ZoomRegion = {
				...current,
				...span,
				depth: op.depth === undefined ? current.depth : requireZoomDepth(op.depth),
				focus: op.focus === undefined ? current.focus : requireFocus(op.focus),
				mode: op.mode ?? (op.focus === undefined ? current.mode : "manual"),
			};
			if (zoom.mode !== "auto" && zoom.mode !== "manual") fail("mode must be auto or manual");
			assertNoZoomOverlap(state.zoomRegions, zoom);
			return {
				state: {
					...state,
					zoomRegions: state.zoomRegions.map((candidate) =>
						candidate.id === zoom.id ? zoom : candidate,
					),
				},
				result,
			};
		}
		case "delete_zoom": {
			const zoom = findById(state.zoomRegions, op.id, "zoom");
			result.removedIds = [zoom.id];
			return {
				state: {
					...state,
					zoomRegions: state.zoomRegions.filter((candidate) => candidate.id !== zoom.id),
				},
				result,
			};
		}
		case "add_annotation": {
			const span = requireSpan(op.startMs, op.endMs, timelineDurationMs(state, ctx));
			const zIndex =
				state.annotationRegions.reduce((max, region) => Math.max(max, region.zIndex), 0) +
				1;
			const base: AnnotationRegion = {
				id: nextId("annotation", state.annotationRegions),
				...span,
				type: "text",
				content: "",
				position: { ...DEFAULT_ANNOTATION_POSITION },
				size: { ...DEFAULT_ANNOTATION_SIZE },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex,
				trackIndex: 0,
			};
			const annotation = buildAnnotation(base, op);
			if (annotation.type === "text" && !annotation.content) {
				fail("text annotations need a non-empty text");
			}
			result.createdIds = [annotation.id];
			return {
				state: { ...state, annotationRegions: [...state.annotationRegions, annotation] },
				result,
			};
		}
		case "update_annotation": {
			const current = findById(state.annotationRegions, op.id, "annotation");
			const span = requireSpan(op.startMs ?? current.startMs, op.endMs ?? current.endMs);
			const annotation = { ...buildAnnotation(current, op), ...span };
			return {
				state: {
					...state,
					annotationRegions: state.annotationRegions.map((candidate) =>
						candidate.id === annotation.id ? annotation : candidate,
					),
				},
				result,
			};
		}
		case "delete_annotation": {
			const annotation = findById(state.annotationRegions, op.id, "annotation");
			result.removedIds = [annotation.id];
			return {
				state: {
					...state,
					annotationRegions: state.annotationRegions.filter(
						(candidate) => candidate.id !== annotation.id,
					),
				},
				result,
			};
		}
		case "add_caption": {
			const span = requireSpan(op.startMs, op.endMs, timelineDurationMs(state, ctx));
			if (typeof op.text !== "string" || !op.text.trim()) fail("text must be non-empty");
			const cue = createCaptionCue({ ...toSourceSpan(state, span), text: op.text.trim() });
			result.createdIds = [cue.id];
			return {
				state: {
					...state,
					autoCaptions: addCue(state.autoCaptions, cue),
					autoCaptionSettings: { ...state.autoCaptionSettings, enabled: true },
				},
				result,
			};
		}
		case "edit_caption": {
			const cue = findById(state.autoCaptions, op.id, "caption");
			let cues = state.autoCaptions;
			if (op.startMs !== undefined || op.endMs !== undefined) {
				const current = { startMs: cue.startMs, endMs: cue.endMs };
				const requested = toSourceSpan(
					state,
					requireSpan(
						op.startMs ?? mapToTimeline(state, current.startMs),
						op.endMs ?? mapToTimeline(state, current.endMs),
					),
				);
				cues = retimeCue(cues, cue.id, {
					startMs: op.startMs === undefined ? current.startMs : requested.startMs,
					endMs: op.endMs === undefined ? current.endMs : requested.endMs,
				});
			}
			if (op.text !== undefined) {
				if (typeof op.text !== "string" || !op.text.trim()) fail("text must be non-empty");
				const text = op.text.trim();
				cues = cues.map((candidate) => {
					if (candidate.id !== cue.id) return candidate;
					// Edited text loses whisper word timings; the renderer re-derives them.
					const { words: _words, ...rest } = candidate;
					return { ...rest, text };
				});
			}
			return { state: { ...state, autoCaptions: cues }, result };
		}
		case "delete_caption": {
			const cue = findById(state.autoCaptions, op.id, "caption");
			result.removedIds = [cue.id];
			return {
				state: { ...state, autoCaptions: deleteCue(state.autoCaptions, cue.id) },
				result,
			};
		}
		case "clear_captions": {
			result.removedIds = state.autoCaptions.map((cue) => cue.id);
			return { state: { ...state, autoCaptions: [] }, result };
		}
		case "set_caption_settings": {
			if (!isRecord(op.settings)) fail("settings must be an object");
			const next = { ...state.autoCaptionSettings };
			for (const [key, value] of Object.entries(op.settings)) {
				if (!(key in next)) fail(`unknown caption setting ${key}`);
				const expected = typeof next[key as keyof AutoCaptionSettings];
				if (typeof value !== expected) fail(`caption setting ${key} must be a ${expected}`);
				(next as Record<string, unknown>)[key] = value;
			}
			return { state: { ...state, autoCaptionSettings: next }, result };
		}
		case "set_appearance": {
			if (!isRecord(op.settings)) fail("settings must be an object");
			const next: AutomationEditorState = { ...state };
			for (const [key, value] of Object.entries(op.settings)) {
				if (key === "motionPreset") {
					const preset = CURSOR_MOTION_PRESETS[value as CursorMotionPresetId];
					if (typeof value !== "string" || !preset) {
						fail(
							`motionPreset must be one of ${Object.keys(CURSOR_MOTION_PRESETS).join(", ")}`,
						);
					}
					const { id: _id, label: _label, ...presetValues } = preset;
					Object.assign(next, presetValues);
					continue;
				}
				const expected =
					AUTOMATION_APPEARANCE_KEYS[key as keyof typeof AUTOMATION_APPEARANCE_KEYS];
				if (!expected) {
					fail(
						`unknown appearance setting ${key}; allowed: motionPreset, ${Object.keys(AUTOMATION_APPEARANCE_KEYS).join(", ")}`,
					);
				}
				if (expected === "object") {
					if (!isRecord(value)) fail(`${key} must be an object`);
					(next as unknown as Record<string, unknown>)[key] = {
						...(state[key as "padding" | "webcam"] as object),
						...value,
					};
					continue;
				}
				if (
					typeof value !== expected ||
					(expected === "number" && !Number.isFinite(value))
				) {
					fail(`${key} must be a ${expected}`);
				}
				if (key.endsWith("Easing") && !ZOOM_EASINGS.has(value as string)) {
					fail(`${key} must be one of ${[...ZOOM_EASINGS].join(", ")}`);
				}
				(next as unknown as Record<string, unknown>)[key] = value;
			}
			if (isRecord(op.settings.padding)) {
				const padding = op.settings.padding;
				// Setting only `top`/`all` style values should keep linked padding consistent.
				if (next.padding.linked && typeof padding.top === "number") {
					next.padding = {
						...next.padding,
						bottom: padding.top,
						left: padding.top,
						right: padding.top,
					};
				}
			}
			return { state: next, result };
		}
		case "set_crop": {
			const crop: CropRegion = {
				x: requireUnit(op.x, "x"),
				y: requireUnit(op.y, "y"),
				width: requireUnit(op.width, "width"),
				height: requireUnit(op.height, "height"),
			};
			if (crop.width <= 0 || crop.height <= 0) fail("width and height must be > 0");
			if (crop.x + crop.width > 1 + 1e-6 || crop.y + crop.height > 1 + 1e-6) {
				fail("crop must stay inside the frame (x + width <= 1, y + height <= 1)");
			}
			return { state: { ...state, cropRegion: crop }, result };
		}
		case "set_aspect_ratio": {
			const ratio = requireString(op.aspectRatio, "aspectRatio");
			if (
				!(ASPECT_RATIOS as readonly string[]).includes(ratio) &&
				!isCustomAspectRatio(ratio)
			) {
				fail(`aspectRatio must be one of ${ASPECT_RATIOS.join(", ")} or a custom "W:H"`);
			}
			return { state: { ...state, aspectRatio: ratio as AspectRatio }, result };
		}
		case "add_audio": {
			const audioPath = requireString(op.path, "path");
			const span = requireSpan(op.startMs, op.endMs);
			const audio: AudioRegion = {
				id: nextId("audio", state.audioRegions),
				...span,
				audioPath,
				volume:
					op.volume === undefined
						? 1
						: Math.max(0, Math.min(1, requireFinite(op.volume, "volume"))),
				normalize: false,
				trackIndex:
					op.trackIndex === undefined
						? undefined
						: Math.max(0, Math.floor(requireFinite(op.trackIndex, "trackIndex"))),
			};
			result.createdIds = [audio.id];
			return { state: { ...state, audioRegions: [...state.audioRegions, audio] }, result };
		}
		case "update_audio": {
			const current = findById(state.audioRegions, op.id, "audio region");
			const span = requireSpan(op.startMs ?? current.startMs, op.endMs ?? current.endMs);
			const volume = optionalFinite(op.volume, "volume");
			if (op.normalize !== undefined && typeof op.normalize !== "boolean") {
				fail("normalize must be a boolean");
			}
			const audio: AudioRegion = {
				...current,
				...span,
				volume: volume === undefined ? current.volume : Math.max(0, Math.min(1, volume)),
				normalize: op.normalize ?? current.normalize,
			};
			return {
				state: {
					...state,
					audioRegions: state.audioRegions.map((candidate) =>
						candidate.id === audio.id ? audio : candidate,
					),
				},
				result,
			};
		}
		case "delete_audio": {
			const audio = findById(state.audioRegions, op.id, "audio region");
			result.removedIds = [audio.id];
			return {
				state: {
					...state,
					audioRegions: state.audioRegions.filter(
						(candidate) => candidate.id !== audio.id,
					),
				},
				result,
			};
		}
		default:
			fail(`unknown op ${(op as { op?: unknown }).op}`);
	}
}

function mapToTimeline(state: AutomationEditorState, sourceMs: number) {
	const clip = state.clipRegions.find((candidate) => {
		const start = getClipSourceStartMs(candidate);
		return (
			sourceMs >= start &&
			sourceMs <= start + (candidate.endMs - candidate.startMs) * candidate.speed
		);
	});
	if (!clip) return sourceMs;
	return Math.round(clip.startMs + (sourceMs - getClipSourceStartMs(clip)) / clip.speed);
}

/**
 * Apply a batch of operations to the editor state. Throws `AutomationOpError`
 * (naming the failing op) without partial application when any op is invalid.
 */
export function applyAutomationOps(
	initial: AutomationEditorState,
	ops: unknown,
	ctx: AutomationContext,
): AutomationOpsOutcome {
	if (!Array.isArray(ops) || ops.length === 0) {
		throw new AutomationOpError(-1, "batch", "ops must be a non-empty array");
	}
	if (ops.length > 500) {
		throw new AutomationOpError(-1, "batch", "a batch may contain at most 500 ops");
	}
	let state = initial;
	const results: AutomationOpResult[] = [];
	ops.forEach((op, index) => {
		const name = isRecord(op) && typeof op.op === "string" ? op.op : "unknown";
		if (!isRecord(op)) throw new AutomationOpError(index, name, "op must be an object");
		try {
			const applied = applyOp(state, op as AutomationOp, ctx);
			state = applied.state;
			results.push(applied.result);
		} catch (error) {
			if (error instanceof OpFailure) throw new AutomationOpError(index, name, error.message);
			throw error;
		}
	});

	const changedKeys = (Object.keys(state) as Array<keyof AutomationEditorState>).filter(
		(key) => JSON.stringify(state[key]) !== JSON.stringify(initial[key]),
	);
	if (changedKeys.length === 0) return { state: initial, results, changedKeys };

	// Clamp through the project normaliser so automated values match what a reload
	// would produce. Only changed keys take the normalised value; untouched editor
	// state is never rewritten as a side effect.
	const normalized = normalizeProjectEditor(state);
	const finalState = { ...initial };
	for (const key of changedKeys) {
		(finalState as Record<string, unknown>)[key] = normalized[key];
	}
	return { state: finalState, results, changedKeys };
}
