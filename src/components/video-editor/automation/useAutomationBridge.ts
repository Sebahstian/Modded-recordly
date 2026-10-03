import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useEffect,
	useRef,
} from "react";
import type { ExportMp4FrameRate, ExportQuality } from "@/lib/exporter";
import type { AspectRatio } from "@/utils/aspectRatioUtils";
import type { useEditorExportController } from "../export/useEditorExportController";
import type { ExportOutcome } from "../export/exportRunnerSupport";
import type { useExportSession } from "../export/useExportSession";
import type { useEditorProjectController } from "../project/useEditorProjectController";
import { deriveNextId, type ProjectEditorState } from "../projectPersistence";
import type { useAppearanceState } from "../state/useAppearanceState";
import type { useProjectState } from "../state/useProjectState";
import type { useTimelineState } from "../state/useTimelineState";
import type { CaptionCue } from "../types";
import type { VideoPlaybackRef } from "../VideoPlayback";
import { supportsPreviewPlaybackRate } from "../videoPlayback/playbackRate";
import { getErrorMessage } from "../videoEditorUtils";
import { type AutomationEditorState, AutomationOpError, applyAutomationOps } from "./automationOps";
import { buildTimelineView, projectTranscript } from "./automationView";

/**
 * Executes automation API requests (forwarded by the main process) against the
 * live editor. Edits go through the same React state the UI uses, so they show
 * up immediately, join undo history, and are picked up by autosave.
 */

type BridgeInput = {
	project: ReturnType<typeof useProjectState>;
	appearance: ReturnType<typeof useAppearanceState>;
	timeline: ReturnType<typeof useTimelineState>;
	aspectRatio: AspectRatio;
	setAspectRatio: Dispatch<SetStateAction<AspectRatio>>;
	duration: number;
	currentTime: number;
	videoPlaybackRef: MutableRefObject<VideoPlaybackRef | null>;
	whisperExecutablePath: string | null;
	whisperModelPath: string | null;
	downloadedWhisperModelPath: string | null;
	projectController: ReturnType<typeof useEditorProjectController>;
	exportController: ReturnType<typeof useEditorExportController>;
	exportSession: ReturnType<typeof useExportSession>;
	refs: {
		nextZoomIdRef: MutableRefObject<number>;
		nextClipIdRef: MutableRefObject<number>;
		nextAudioIdRef: MutableRefObject<number>;
		nextAnnotationIdRef: MutableRefObject<number>;
		nextAnnotationZIndexRef: MutableRefObject<number>;
	};
};

type ExportJob = {
	jobId: string;
	format: "mp4" | "gif";
	outputPath: string;
	status: "running" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	path?: string;
	error?: string;
};

class BridgeError extends Error {
	constructor(
		message: string,
		readonly code = "editor_error",
	) {
		super(message);
	}
}

const EXPORT_QUALITIES = new Set<ExportQuality>(["medium", "good", "high", "source"]);
const EXPORT_FPS = new Set<number>([24, 30, 60]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nextFrame() {
	return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function delay(ms: number) {
	return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function capitalize(key: string) {
	return `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

export function useAutomationBridge(input: BridgeInput) {
	const latest = useRef(input);
	latest.current = input;
	const exportJobRef = useRef<ExportJob | null>(null);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api?.onAutomationRequest || !api.sendAutomationResponse) return;

		const waitFor = async (predicate: () => boolean, timeoutMs: number, intervalMs = 100) => {
			const deadline = Date.now() + timeoutMs;
			while (!predicate()) {
				if (Date.now() > deadline) return false;
				await delay(intervalMs);
			}
			return true;
		};

		const persistedSnapshot = () =>
			latest.current.projectController.snapshot.currentPersistedEditorState;

		/**
		 * Setter calls only take effect on React's next render. Wait for it so the
		 * reply (and the next request) sees the edited state, not the old one.
		 */
		const waitForCommit = (before: ReturnType<typeof persistedSnapshot>) =>
			waitFor(() => persistedSnapshot() !== before, 2000, 16);

		// Mutating requests run one at a time so a batch never starts from state
		// that an earlier, still-committing batch is about to replace.
		let mutationQueue: Promise<unknown> = Promise.resolve();
		const serial = <T>(task: () => Promise<T>): Promise<T> => {
			const run = mutationQueue.then(task, task);
			mutationQueue = run.catch(() => undefined);
			return run;
		};

		/**
		 * Source media length in seconds. Reopening a project on the same recording
		 * keeps the <video> element (same URL), so no new loadedmetadata event resets
		 * the editor's duration state; fall back to the element itself.
		 */
		const mediaDurationSeconds = () => {
			const { duration, videoPlaybackRef } = latest.current;
			if (duration > 0) return duration;
			const videoDuration = videoPlaybackRef.current?.video?.duration;
			return videoDuration && Number.isFinite(videoDuration) ? videoDuration : 0;
		};

		const isEditorReady = () => {
			const current = latest.current;
			return (
				Boolean(current.project.videoPath) &&
				!current.project.loading &&
				!current.project.error &&
				mediaDurationSeconds() > 0 &&
				current.timeline.clipRegions.length > 0
			);
		};

		const requireEditorReady = () => {
			if (isEditorReady()) return;
			const { error } = latest.current.project;
			throw new BridgeError(
				error
					? `The editor is showing an error: ${error}`
					: "The editor has no recording loaded yet. Open a project or wait for the recording to finish loading.",
				"not_ready",
			);
		};

		const currentState = (): AutomationEditorState => {
			const current = latest.current;
			return {
				...current.projectController.snapshot.currentPersistedEditorState,
				zoomMotionBlurTuning: current.appearance.zoomMotionBlurTuning,
			} as ProjectEditorState;
		};

		const sourceDurationMs = () => Math.round(mediaDurationSeconds() * 1000);

		const describe = () => {
			const current = latest.current;
			const sourcePath = current.projectController.snapshot.currentSourcePath;
			return {
				project: {
					path: current.project.currentProjectPath,
					name: current.projectController.snapshot.projectDisplayName,
					videoPath: sourcePath,
					hasUnsavedChanges: current.projectController.hasUnsavedChanges,
				},
				ready: isEditorReady(),
				error: current.project.error,
				playheadMs: Math.round(current.currentTime * 1000),
				canUndo: current.projectController.history.canUndo,
				canRedo: current.projectController.history.canRedo,
				isExporting: current.exportSession.isExporting,
				timeline: buildTimelineView(currentState(), sourceDurationMs()),
			};
		};

		const pushState = (
			next: AutomationEditorState,
			changedKeys: Array<keyof ProjectEditorState>,
		) => {
			const { timeline, appearance, setAspectRatio, refs } = latest.current;
			// Resolve every setter before calling any, so a batch is never half-applied.
			const updates = changedKeys.map((key) => {
				if (key === "aspectRatio") {
					return () => setAspectRatio(next.aspectRatio);
				}
				const setterName = `set${capitalize(key)}`;
				const owner = [timeline, appearance].find(
					(candidate) =>
						typeof (candidate as Record<string, unknown>)[setterName] === "function",
				) as Record<string, (value: unknown) => void> | undefined;
				if (!owner) throw new BridgeError(`Cannot apply editor field ${key}`);
				return () => owner[setterName](next[key]);
			});
			for (const update of updates) update();

			const bump = (ref: MutableRefObject<number>, prefix: string, ids: string[]) => {
				ref.current = Math.max(ref.current, deriveNextId(prefix, ids));
			};
			bump(
				refs.nextZoomIdRef,
				"zoom",
				next.zoomRegions.map(({ id }) => id),
			);
			bump(
				refs.nextClipIdRef,
				"clip",
				next.clipRegions.map(({ id }) => id),
			);
			bump(
				refs.nextAudioIdRef,
				"audio",
				next.audioRegions.map(({ id }) => id),
			);
			bump(
				refs.nextAnnotationIdRef,
				"annotation",
				next.annotationRegions.map(({ id }) => id),
			);
			refs.nextAnnotationZIndexRef.current = Math.max(
				refs.nextAnnotationZIndexRef.current,
				next.annotationRegions.reduce((max, region) => Math.max(max, region.zIndex), 0) + 1,
			);

			// Drop selections that point at regions the batch removed.
			const clearIfGone = (
				selected: string | null,
				ids: Array<{ id: string }>,
				clear: (value: null) => void,
			) => {
				if (selected && !ids.some(({ id }) => id === selected)) clear(null);
			};
			clearIfGone(timeline.selectedZoomId, next.zoomRegions, timeline.setSelectedZoomId);
			clearIfGone(timeline.selectedClipId, next.clipRegions, timeline.setSelectedClipId);
			clearIfGone(
				timeline.selectedAnnotationId,
				next.annotationRegions,
				timeline.setSelectedAnnotationId,
			);
			clearIfGone(timeline.selectedAudioId, next.audioRegions, timeline.setSelectedAudioId);
			clearIfGone(
				timeline.selectedCaptionId,
				next.autoCaptions,
				timeline.setSelectedCaptionId,
			);
		};

		const whisperModel = () => {
			const current = latest.current;
			const modelPath = current.whisperModelPath ?? current.downloadedWhisperModelPath;
			if (!modelPath) {
				throw new BridgeError(
					"No Whisper model is set up. In Recordly, open the Captions panel and download the small Whisper model (one time), then try again.",
					"whisper_missing",
				);
			}
			return modelPath;
		};

		const runWhisper = async (): Promise<CaptionCue[]> => {
			const current = latest.current;
			const videoPath = current.projectController.snapshot.currentSourcePath;
			if (!videoPath) throw new BridgeError("No recording is loaded", "not_ready");
			const result = await window.electronAPI.generateAutoCaptions({
				videoPath,
				whisperExecutablePath: current.whisperExecutablePath ?? undefined,
				whisperModelPath: whisperModel(),
				language: current.timeline.autoCaptionSettings.language,
			});
			if (!result.success || !result.cues) {
				throw new BridgeError(
					result.error
						? getErrorMessage(result.error)
						: result.message || "Transcription failed",
					"transcription_failed",
				);
			}
			return result.cues as CaptionCue[];
		};

		const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
			get_state: async () => describe(),

			apply_ops: (params) =>
				serial(async () => {
					requireEditorReady();
					if (latest.current.exportSession.isExporting) {
						throw new BridgeError(
							"Wait for the running export to finish before editing",
							"busy",
						);
					}
					const outcome = applyAutomationOps(currentState(), params.ops, {
						sourceDurationMs: sourceDurationMs(),
						isSupportedClipSpeed: supportsPreviewPlaybackRate,
					});
					if (outcome.changedKeys.length > 0) {
						const before = persistedSnapshot();
						pushState(outcome.state, outcome.changedKeys);
						await waitForCommit(before);
					}
					return {
						applied: outcome.results.length,
						results: outcome.results,
						changed: outcome.changedKeys,
						timeline: buildTimelineView(outcome.state, sourceDurationMs()),
					};
				}),

			undo: () =>
				serial(async () => {
					if (!latest.current.projectController.history.canUndo) {
						throw new BridgeError("Nothing to undo", "nothing_to_undo");
					}
					const before = persistedSnapshot();
					latest.current.projectController.history.handleUndo();
					await waitForCommit(before);
					return describe();
				}),

			redo: () =>
				serial(async () => {
					if (!latest.current.projectController.history.canRedo) {
						throw new BridgeError("Nothing to redo", "nothing_to_redo");
					}
					const before = persistedSnapshot();
					latest.current.projectController.history.handleRedo();
					await waitForCommit(before);
					return describe();
				}),

			save: async () => {
				requireEditorReady();
				const saved = await latest.current.projectController.saveActions.saveProject(
					false,
					{
						silent: true,
					},
				);
				await nextFrame();
				return {
					saved: Boolean(saved),
					projectPath: latest.current.project.currentProjectPath,
				};
			},

			seek: async (params) => {
				requireEditorReady();
				const timeMs = typeof params.timeMs === "number" ? params.timeMs : Number.NaN;
				if (!Number.isFinite(timeMs) || timeMs < 0) {
					throw new BridgeError("timeMs must be a non-negative number", "invalid_params");
				}
				const playback = latest.current.videoPlaybackRef.current;
				playback?.pause();
				playback?.seekTimeline(timeMs / 1000);
				return { playheadMs: Math.round(timeMs) };
			},

			prepare_frame: async (params) => {
				requireEditorReady();
				const playback = latest.current.videoPlaybackRef.current;
				const container = playback?.containerRef.current;
				if (!playback || !container)
					throw new BridgeError("The preview is not visible", "not_ready");
				let timeMs = Math.round(latest.current.currentTime * 1000);
				if (typeof params.timeMs === "number" && Number.isFinite(params.timeMs)) {
					timeMs = Math.max(0, Math.round(params.timeMs));
					playback.pause();
					playback.seekTimeline(timeMs / 1000);
					const video = playback.video;
					if (video?.seeking) {
						await new Promise<void>((resolve) => {
							const done = () => resolve();
							video.addEventListener("seeked", done, { once: true });
							window.setTimeout(done, 3000);
						});
					}
				}
				await playback.refreshFrame().catch(() => undefined);
				await nextFrame();
				await nextFrame();
				const rect = container.getBoundingClientRect();
				return {
					timeMs,
					rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
				};
			},

			transcript: async (params) => {
				requireEditorReady();
				const existing = latest.current.timeline.autoCaptions;
				const hasWordTimings = existing.some((cue) => (cue.words?.length ?? 0) > 0);
				const useExisting =
					params.refresh !== true && existing.length > 0 && hasWordTimings;
				const cues = useExisting ? existing : await runWhisper();
				const segments = projectTranscript(cues, latest.current.timeline.clipRegions);
				return {
					source: useExisting ? "captions" : "whisper",
					language: latest.current.timeline.autoCaptionSettings.language,
					segments,
				};
			},

			generate_captions: async () => {
				requireEditorReady();
				const cues = await runWhisper();
				return serial(async () => {
					const { timeline } = latest.current;
					const before = persistedSnapshot();
					timeline.setAutoCaptions(cues);
					if (cues.length > 0) {
						timeline.setAutoCaptionSettings((current) => ({
							...current,
							enabled: true,
						}));
					}
					await waitForCommit(before);
					return { captions: cues.length };
				});
			},

			open_project: (params) =>
				serial(async () => {
					if (typeof params.path !== "string") {
						throw new BridgeError("path must be a string", "invalid_params");
					}
					if (latest.current.exportSession.isExporting) {
						throw new BridgeError(
							"Wait for the running export to finish first",
							"busy",
						);
					}
					const opened =
						await latest.current.projectController.openActions.handleOpenProjectFromLibrary(
							params.path,
						);
					if (!opened) {
						await nextFrame();
						throw new BridgeError(
							latest.current.project.error || "Could not open the project",
							"open_failed",
						);
					}
					await waitFor(isEditorReady, 30_000);
					return describe();
				}),

			start_export: async (params) => {
				requireEditorReady();
				const format = params.format === "gif" ? "gif" : "mp4";
				if (typeof params.outputPath !== "string") {
					throw new BridgeError("outputPath is required", "invalid_params");
				}
				if (
					params.quality !== undefined &&
					!EXPORT_QUALITIES.has(params.quality as ExportQuality)
				) {
					throw new BridgeError(
						"quality must be medium, good, high or source",
						"invalid_params",
					);
				}
				if (params.fps !== undefined && !EXPORT_FPS.has(params.fps as number)) {
					throw new BridgeError("fps must be 24, 30 or 60", "invalid_params");
				}
				const job: ExportJob = {
					jobId: globalThis.crypto.randomUUID(),
					format,
					outputPath: params.outputPath,
					status: "running",
					startedAt: new Date().toISOString(),
				};
				const refusal = latest.current.exportController.dialogActions.startAutomatedExport({
					format,
					outputPath: params.outputPath,
					quality: params.quality as ExportQuality | undefined,
					fps: params.fps as ExportMp4FrameRate | undefined,
					onOutcome: (outcome: ExportOutcome) => {
						if (exportJobRef.current?.jobId !== job.jobId) return;
						exportJobRef.current = {
							...job,
							status: outcome.success ? "done" : "failed",
							finishedAt: new Date().toISOString(),
							...(outcome.success
								? { path: outcome.path }
								: { error: outcome.error }),
						};
					},
				});
				if (refusal) throw new BridgeError(refusal.message, refusal.code);
				exportJobRef.current = job;
				return job;
			},

			export_status: async () => {
				const { exportSession } = latest.current;
				const progress = exportSession.exportProgress;
				return {
					job: exportJobRef.current,
					isExporting: exportSession.isExporting,
					progress: progress
						? {
								percentage: Math.round(progress.percentage * 10) / 10,
								phase: progress.phase ?? "rendering",
								estimatedSecondsRemaining: Math.round(
									progress.estimatedTimeRemaining,
								),
							}
						: null,
				};
			},

			cancel_export: async () => {
				if (!latest.current.exportSession.isExporting) {
					throw new BridgeError("No export is running", "not_exporting");
				}
				latest.current.exportController.dialogActions.handleCancelExport();
				return { canceled: true };
			},
		};

		return api.onAutomationRequest(async (request) => {
			const handler = handlers[request.method];
			try {
				if (!handler)
					throw new BridgeError(`Unknown method ${request.method}`, "unknown_method");
				const result = await handler(isRecord(request.params) ? request.params : {});
				api.sendAutomationResponse({ id: request.id, ok: true, result });
			} catch (error) {
				const code =
					error instanceof AutomationOpError
						? "invalid_op"
						: error instanceof BridgeError
							? error.code
							: "editor_error";
				api.sendAutomationResponse({
					id: request.id,
					ok: false,
					error: { message: getErrorMessage(error), code },
				});
			}
		});
	}, []);
}
