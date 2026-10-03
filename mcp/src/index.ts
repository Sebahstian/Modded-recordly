#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RecordlyApiError, RecordlyClient } from "./client.js";
import { GUIDE_MARKDOWN, SERVER_INSTRUCTIONS } from "./guide.js";
import { opSchema } from "./schemas.js";

const VERSION = "0.1.0";
const LONG_TIMEOUT_MS = 16 * 60_000;
const EXPORT_POLL_MS = 1500;
const EXPORT_MAX_WAIT_MS = 2 * 60 * 60_000;

type TranscriptWord = {
	text: string;
	startMs: number | null;
	endMs: number | null;
};
type TranscriptSegment = {
	cueId: string;
	text: string;
	startMs: number | null;
	endMs: number | null;
	words: TranscriptWord[];
};
type ExportStatus = {
	job: {
		jobId: string;
		status: "running" | "done" | "failed";
		path?: string;
		error?: string;
		outputPath: string;
	} | null;
	isExporting: boolean;
	progress: { percentage: number; phase: string; estimatedSecondsRemaining: number } | null;
};

const client = new RecordlyClient();

function json(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
	const message =
		error instanceof RecordlyApiError
			? `${error.message}${error.code && error.code !== "error" ? ` [${error.code}]` : ""}`
			: error instanceof Error
				? error.message
				: String(error);
	return { content: [{ type: "text", text: message }], isError: true };
}

async function run(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await action();
	} catch (error) {
		return failure(error);
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const server = new McpServer(
	{ name: "recordly", version: VERSION },
	{ instructions: SERVER_INSTRUCTIONS },
);

server.registerResource(
	"guide",
	"recordly://guide",
	{
		title: "Recordly editing guide",
		description: "How Recordly's timeline works, value ranges, and editing recipes.",
		mimeType: "text/markdown",
	},
	async (uri) => ({
		contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE_MARKDOWN }],
	}),
);

server.registerTool(
	"recordly_status",
	{
		title: "Recordly status",
		description:
			"Check that Recordly is running with the local API on, whether an editor is open, and which project is loaded.",
		annotations: { readOnlyHint: true },
	},
	async () => run(async () => json(await client.get("/v1/status"))),
);

server.registerTool(
	"get_guide",
	{
		title: "Editing guide",
		description:
			"Read Recordly's editing guide: timeline model, recipes (removing filler words, zooms, callouts, vertical shorts) and allowed values for appearance settings.",
		annotations: { readOnlyHint: true },
	},
	async () => ({ content: [{ type: "text", text: GUIDE_MARKDOWN }] }),
);

server.registerTool(
	"list_projects",
	{
		title: "List projects",
		description: "List saved Recordly projects (newest first) with their file paths.",
		annotations: { readOnlyHint: true },
	},
	async () => run(async () => json(await client.get("/v1/projects"))),
);

server.registerTool(
	"open_project",
	{
		title: "Open project",
		description:
			"Open a saved .recordly project in the editor (opening the editor window if needed). Unsaved changes in the current project are saved first.",
		inputSchema: { path: z.string().describe("Absolute path to the .recordly file") },
	},
	async ({ path }) =>
		run(async () =>
			json(await client.post("/v1/projects/open", { path }, { timeoutMs: 180_000 })),
		),
);

server.registerTool(
	"get_timeline",
	{
		title: "Get timeline",
		description:
			"Read the open project: clips, zooms, annotations, audio, captions (all in timeline ms), canvas/appearance settings, playhead and undo availability.",
		annotations: { readOnlyHint: true },
	},
	async () => run(async () => json(await client.get("/v1/editor/state"))),
);

server.registerTool(
	"get_transcript",
	{
		title: "Get transcript",
		description:
			"Word-level transcript of the recording mapped onto the edited timeline. Words in cut footage have startMs null. Uses existing captions when they have word timings; otherwise runs Whisper (can take a minute).",
		inputSchema: {
			refresh: z
				.boolean()
				.optional()
				.describe("Re-run Whisper even if captions already exist"),
			includeWords: z
				.boolean()
				.optional()
				.describe(
					"Include per-word timings (default true). Set false for long videos to save space.",
				),
		},
		annotations: { readOnlyHint: true },
	},
	async ({ refresh, includeWords }) =>
		run(async () => {
			const transcript = await client.post<{
				source: string;
				language: string;
				segments: TranscriptSegment[];
			}>(
				"/v1/editor/transcript",
				{ refresh: refresh === true },
				{ timeoutMs: LONG_TIMEOUT_MS },
			);
			return json({
				source: transcript.source,
				language: transcript.language,
				note: "Times are timeline ms. words: [text, startMs, endMs]; null = cut.",
				segments: transcript.segments.map((segment) => ({
					startMs: segment.startMs,
					endMs: segment.endMs,
					text: segment.text,
					...(includeWords === false
						? {}
						: {
								words: segment.words.map((word) => [
									word.text,
									word.startMs,
									word.endMs,
								]),
							}),
				})),
			});
		}),
);

server.registerTool(
	"apply_edits",
	{
		title: "Apply edits",
		description:
			"Apply a batch of timeline edits atomically (all or nothing). Ops run in order and each sees the result of the previous ones. Returns created ids and the updated timeline.",
		inputSchema: {
			ops: z.array(opSchema).min(1).max(500).describe("Edit operations, applied in order"),
		},
	},
	async ({ ops }) => run(async () => json(await client.post("/v1/editor/ops", { ops }))),
);

server.registerTool(
	"undo",
	{ title: "Undo", description: "Undo the last timeline edit in Recordly." },
	async () => run(async () => json(await client.post("/v1/editor/undo"))),
);

server.registerTool(
	"redo",
	{ title: "Redo", description: "Redo the last undone timeline edit in Recordly." },
	async () => run(async () => json(await client.post("/v1/editor/redo"))),
);

server.registerTool(
	"save_project",
	{
		title: "Save project",
		description:
			"Save the open project now (Recordly also autosaves). A brand-new recording may show a save dialog in the app.",
	},
	async () =>
		run(async () => json(await client.post("/v1/editor/save", {}, { timeoutMs: 180_000 }))),
);

server.registerTool(
	"preview_frame",
	{
		title: "Preview frame",
		description:
			"Screenshot the editor preview (with background, zoom, cursor, annotations and captions applied) at a timeline time, to check how an edit looks.",
		inputSchema: {
			timeMs: z
				.number()
				.min(0)
				.optional()
				.describe("Timeline time to show; omit for the current playhead"),
		},
		annotations: { readOnlyHint: true },
	},
	async ({ timeMs }) =>
		run(async () => {
			const frame = await client.post<{ mimeType: string; data: string; timeMs: number }>(
				"/v1/editor/frame",
				{ timeMs },
			);
			return {
				content: [
					{ type: "image", data: frame.data, mimeType: frame.mimeType },
					{ type: "text", text: `Preview at ${frame.timeMs} ms` },
				],
			};
		}),
);

server.registerTool(
	"generate_captions",
	{
		title: "Generate captions",
		description:
			"Transcribe the recording with Whisper and replace the project's subtitles with the result (turns subtitles on). Needs the Whisper model downloaded once in Recordly's Captions panel.",
	},
	async () =>
		run(async () =>
			json(
				await client.post(
					"/v1/editor/captions/generate",
					{},
					{ timeoutMs: LONG_TIMEOUT_MS },
				),
			),
		),
);

server.registerTool(
	"export_video",
	{
		title: "Export video",
		description:
			"Render the edited project to an MP4 or GIF file. Waits for the export to finish (reporting progress) unless wait is false.",
		inputSchema: {
			outputPath: z
				.string()
				.describe("Absolute destination path ending in .mp4 or .gif (~ is allowed)"),
			format: z.enum(["mp4", "gif"]).optional().describe("Default mp4"),
			quality: z
				.enum(["medium", "good", "high", "source"])
				.optional()
				.describe("MP4 quality; default is the user's last choice in Recordly"),
			fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
			overwrite: z.boolean().optional().describe("Replace an existing file at outputPath"),
			wait: z.boolean().optional().describe("Wait until the file is written (default true)"),
		},
	},
	async ({ outputPath, format, quality, fps, overwrite, wait }, extra) =>
		run(async () => {
			const job = await client.post<{ jobId: string }>("/v1/export", {
				outputPath,
				format: format ?? "mp4",
				quality,
				fps,
				overwrite,
			});
			if (wait === false) return json({ started: true, ...job });

			const progressToken = extra._meta?.progressToken;
			const deadline = Date.now() + EXPORT_MAX_WAIT_MS;
			while (Date.now() < deadline) {
				await sleep(EXPORT_POLL_MS);
				const status = await client.get<ExportStatus>("/v1/export");
				if (!status.job || status.job.jobId !== job.jobId) {
					throw new Error("The export was replaced by another export");
				}
				if (status.job.status === "done") {
					return json({ exported: true, path: status.job.path });
				}
				if (status.job.status === "failed") {
					throw new Error(`Export failed: ${status.job.error ?? "unknown error"}`);
				}
				if (progressToken !== undefined && status.progress) {
					await extra
						.sendNotification({
							method: "notifications/progress",
							params: {
								progressToken,
								progress: status.progress.percentage,
								total: 100,
								message: `${status.progress.phase} ${Math.round(status.progress.percentage)}%`,
							},
						})
						.catch(() => undefined);
				}
			}
			throw new Error("Timed out waiting for the export; check export_status");
		}),
);

server.registerTool(
	"export_status",
	{
		title: "Export status",
		description: "Progress of the current or last export started through this API.",
		annotations: { readOnlyHint: true },
	},
	async () => run(async () => json(await client.get("/v1/export"))),
);

server.registerTool(
	"cancel_export",
	{ title: "Cancel export", description: "Stop the export that is running in Recordly." },
	async () => run(async () => json(await client.post("/v1/export/cancel"))),
);

await server.connect(new StdioServerTransport());
