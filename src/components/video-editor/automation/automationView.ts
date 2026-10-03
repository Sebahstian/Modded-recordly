/**
 * Read-only views of the editor for the automation API: a compact timeline
 * summary and transcript words projected from recording time onto the timeline.
 */
import { projectCaptionCues } from "../captionTimeline";
import { normalizeCaptionWords } from "../captionEditing";
import { getMatchingCursorMotionPresetId } from "../cursorMotionPresets";
import {
	type CaptionCue,
	type ClipRegion,
	getClipSourceEndMs,
	getClipSourceStartMs,
	getTimelineDurationMs,
	sortClipRegions,
	ZOOM_DEPTH_SCALES,
} from "../types";
import { AUTOMATION_APPEARANCE_KEYS, type AutomationEditorState } from "./automationOps";

export interface AutomationTimelineView {
	timelineDurationMs: number;
	sourceDurationMs: number;
	clips: Array<{
		id: string;
		startMs: number;
		endMs: number;
		sourceStartMs: number;
		sourceEndMs: number;
		speed: number;
		muted: boolean;
	}>;
	zooms: Array<{
		id: string;
		startMs: number;
		endMs: number;
		depth: number;
		scale: number;
		focus: { cx: number; cy: number };
		mode: string;
	}>;
	annotations: Array<{
		id: string;
		startMs: number;
		endMs: number;
		type: string;
		text?: string;
		position: { x: number; y: number };
		size: { width: number; height: number };
		trackIndex: number;
	}>;
	audio: Array<{
		id: string;
		startMs: number;
		endMs: number;
		path: string;
		volume: number;
		trackIndex: number;
	}>;
	/** Caption cues as they appear on the timeline (cut footage hides its captions). */
	captions: Array<{ id: string; startMs: number; endMs: number; text: string }>;
	captionSettings: AutomationEditorState["autoCaptionSettings"];
	aspectRatio: string;
	crop: AutomationEditorState["cropRegion"];
	appearance: Record<string, unknown>;
}

export function buildTimelineView(
	state: AutomationEditorState,
	sourceDurationMs: number,
): AutomationTimelineView {
	const clips = sortClipRegions(state.clipRegions);
	const captions = new Map<
		string,
		{ id: string; startMs: number; endMs: number; text: string }
	>();
	for (const fragment of projectCaptionCues(state.autoCaptions, clips)) {
		const existing = captions.get(fragment.sourceCueId);
		const startMs = Math.round(fragment.startMs);
		const endMs = Math.round(fragment.endMs);
		if (existing) {
			existing.startMs = Math.min(existing.startMs, startMs);
			existing.endMs = Math.max(existing.endMs, endMs);
		} else {
			captions.set(fragment.sourceCueId, {
				id: fragment.sourceCueId,
				startMs,
				endMs,
				text: fragment.sourceCue.text,
			});
		}
	}

	const appearance: Record<string, unknown> = {
		motionPreset: getMatchingCursorMotionPresetId(state) ?? "custom",
	};
	for (const key of Object.keys(AUTOMATION_APPEARANCE_KEYS)) {
		appearance[key] = state[key as keyof AutomationEditorState];
	}

	return {
		timelineDurationMs: getTimelineDurationMs(clips, sourceDurationMs),
		sourceDurationMs: Math.round(sourceDurationMs),
		clips: clips.map((clip) => ({
			id: clip.id,
			startMs: clip.startMs,
			endMs: clip.endMs,
			sourceStartMs: getClipSourceStartMs(clip),
			sourceEndMs: getClipSourceEndMs(clip),
			speed: clip.speed,
			muted: Boolean(clip.muted),
		})),
		zooms: [...state.zoomRegions]
			.sort((left, right) => left.startMs - right.startMs)
			.map((zoom) => ({
				id: zoom.id,
				startMs: zoom.startMs,
				endMs: zoom.endMs,
				depth: zoom.depth,
				scale: ZOOM_DEPTH_SCALES[zoom.depth],
				focus: zoom.focus,
				mode: zoom.mode ?? "auto",
			})),
		annotations: [...state.annotationRegions]
			.sort((left, right) => left.startMs - right.startMs)
			.map((annotation) => ({
				id: annotation.id,
				startMs: annotation.startMs,
				endMs: annotation.endMs,
				type: annotation.type,
				...(annotation.type === "text"
					? { text: annotation.textContent ?? annotation.content }
					: {}),
				position: annotation.position,
				size: annotation.size,
				trackIndex: annotation.trackIndex ?? 0,
			})),
		audio: state.audioRegions.map((audio) => ({
			id: audio.id,
			startMs: audio.startMs,
			endMs: audio.endMs,
			path: audio.audioPath,
			volume: audio.volume,
			trackIndex: audio.trackIndex ?? 0,
		})),
		captions: [...captions.values()].sort((left, right) => left.startMs - right.startMs),
		captionSettings: state.autoCaptionSettings,
		aspectRatio: state.aspectRatio,
		crop: state.cropRegion,
		appearance,
	};
}

export interface TranscriptWord {
	text: string;
	/** Timeline position, or null when the word's footage has been cut. */
	startMs: number | null;
	endMs: number | null;
	sourceStartMs: number;
	sourceEndMs: number;
}

export interface TranscriptSegment {
	cueId: string;
	text: string;
	startMs: number | null;
	endMs: number | null;
	words: TranscriptWord[];
}

function sourceToTimeline(sourceMs: number, clips: ClipRegion[], edge: "start" | "end") {
	for (const clip of clips) {
		const start = getClipSourceStartMs(clip);
		const end = getClipSourceEndMs(clip);
		const inside =
			edge === "start"
				? sourceMs >= start && sourceMs < end
				: sourceMs > start && sourceMs <= end;
		if (inside) return Math.round(clip.startMs + (sourceMs - start) / clip.speed);
	}
	return null;
}

/**
 * Project caption cues (recording time) onto the edited timeline, word by word.
 * Words whose footage was cut get `startMs: null`.
 */
export function projectTranscript(
	cues: CaptionCue[],
	clipRegions: ClipRegion[],
): TranscriptSegment[] {
	const clips = sortClipRegions(clipRegions);
	return [...cues]
		.sort((left, right) => left.startMs - right.startMs)
		.map((cue) => {
			const words = normalizeCaptionWords(cue).map((word) => ({
				text: word.text,
				startMs: sourceToTimeline(word.startMs, clips, "start"),
				endMs: sourceToTimeline(word.endMs, clips, "end"),
				sourceStartMs: word.startMs,
				sourceEndMs: word.endMs,
			}));
			const visible = words.filter((word) => word.startMs !== null && word.endMs !== null);
			return {
				cueId: cue.id,
				text: cue.text,
				startMs: visible.length > 0 ? (visible[0].startMs as number) : null,
				endMs: visible.length > 0 ? (visible[visible.length - 1].endMs as number) : null,
				words,
			};
		});
}
