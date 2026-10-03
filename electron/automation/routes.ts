import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CaptureRect, EditorRpc } from "./editorRpc";
import { AutomationHttpError, type AutomationRequest } from "./server";

export const AUTOMATION_API_VERSION = 1;

export interface AutomationRouteDeps {
	rpc: EditorRpc;
	appVersion: string;
	getCurrentProjectPath(): string | null;
	listProjects(): Promise<unknown>;
	/** Open (or focus) the editor window. */
	openEditorWindow(): void;
	/** Let the editor's media server read a user-supplied file (e.g. an audio track). */
	approveReadPath(filePath: string): Promise<void>;
}

const PROJECT_EXTENSIONS = [".recordly", ".openscreen"];
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm"]);
const EDITOR_OPEN_TIMEOUT_MS = 60_000;
const LONG_CALL_TIMEOUT_MS = 15 * 60_000;
const PREVIEW_MAX_WIDTH = 1280;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bodyOf(request: AutomationRequest): Record<string, unknown> {
	if (request.body === undefined || request.body === null) return {};
	if (!isRecord(request.body)) {
		throw new AutomationHttpError(400, "Request body must be a JSON object", "invalid_body");
	}
	return request.body;
}

/** Resolve a user-supplied path: expand `~`, require it to be absolute. */
export function resolveUserPath(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AutomationHttpError(400, `${name} must be a file path`, "invalid_path");
	}
	const trimmed = value.trim();
	const expanded =
		trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
			? path.join(os.homedir(), trimmed.slice(1))
			: trimmed;
	if (!path.isAbsolute(expanded)) {
		throw new AutomationHttpError(400, `${name} must be an absolute path`, "invalid_path");
	}
	return path.resolve(expanded);
}

async function statOrNull(filePath: string) {
	try {
		return await fs.stat(filePath);
	} catch {
		return null;
	}
}

async function requireFile(filePath: string, name: string) {
	const stats = await statOrNull(filePath);
	if (!stats?.isFile()) {
		throw new AutomationHttpError(404, `${name} does not exist: ${filePath}`, "not_found");
	}
}

/** Check an export destination before any rendering starts. */
export async function validateExportTarget(body: Record<string, unknown>) {
	const format = body.format ?? "mp4";
	if (format !== "mp4" && format !== "gif") {
		throw new AutomationHttpError(400, "format must be mp4 or gif", "invalid_format");
	}
	const outputPath = resolveUserPath(body.outputPath, "outputPath");
	if (path.extname(outputPath).toLowerCase() !== `.${format}`) {
		throw new AutomationHttpError(
			400,
			`outputPath must end with .${format} for a ${format} export`,
			"invalid_path",
		);
	}
	const parent = await statOrNull(path.dirname(outputPath));
	if (!parent?.isDirectory()) {
		throw new AutomationHttpError(
			400,
			`The folder ${path.dirname(outputPath)} does not exist`,
			"invalid_path",
		);
	}
	if ((await statOrNull(outputPath)) && body.overwrite !== true) {
		throw new AutomationHttpError(
			409,
			`${outputPath} already exists; pass overwrite: true to replace it`,
			"exists",
		);
	}
	return { format, outputPath };
}

async function prepareOps(ops: unknown, deps: AutomationRouteDeps) {
	if (!Array.isArray(ops) || ops.length === 0) {
		throw new AutomationHttpError(400, "ops must be a non-empty array", "invalid_body");
	}
	return Promise.all(
		ops.map(async (op) => {
			if (!isRecord(op) || op.op !== "add_audio") return op;
			const audioPath = resolveUserPath(op.path, "add_audio.path");
			if (!AUDIO_EXTENSIONS.has(path.extname(audioPath).toLowerCase())) {
				throw new AutomationHttpError(
					400,
					`add_audio.path must be an audio file (${[...AUDIO_EXTENSIONS].join(", ")})`,
					"invalid_path",
				);
			}
			await requireFile(audioPath, "add_audio.path");
			await deps.approveReadPath(audioPath);
			return { ...op, path: audioPath };
		}),
	);
}

async function capturePreview(deps: AutomationRouteDeps, timeMs: unknown) {
	const prepared = (await deps.rpc.call("prepare_frame", {
		timeMs: typeof timeMs === "number" ? timeMs : undefined,
	})) as { rect: CaptureRect; timeMs: number };
	const target = deps.rpc.getReadyTarget();
	if (!target?.capture) {
		throw new AutomationHttpError(409, "The editor window cannot be captured", "no_editor");
	}
	const image = await target.capture(prepared.rect, PREVIEW_MAX_WIDTH);
	return { mimeType: "image/jpeg", data: image.toString("base64"), timeMs: prepared.timeMs };
}

export function createAutomationRouter(deps: AutomationRouteDeps) {
	const { rpc } = deps;
	return async (request: AutomationRequest): Promise<unknown> => {
		const route = `${request.method} ${request.path}`;
		switch (route) {
			case "GET /v1/status":
				return {
					app: "Recordly",
					appVersion: deps.appVersion,
					apiVersion: AUTOMATION_API_VERSION,
					editorOpen: rpc.hasReadyEditor(),
					projectPath: deps.getCurrentProjectPath(),
				};
			case "GET /v1/projects":
				return deps.listProjects();
			case "POST /v1/projects/open": {
				const projectPath = resolveUserPath(bodyOf(request).path, "path");
				if (!PROJECT_EXTENSIONS.includes(path.extname(projectPath).toLowerCase())) {
					throw new AutomationHttpError(
						400,
						"path must be a .recordly project",
						"invalid_path",
					);
				}
				await requireFile(projectPath, "project");
				if (!rpc.hasReadyEditor()) {
					deps.openEditorWindow();
					await rpc.waitForReady(EDITOR_OPEN_TIMEOUT_MS);
				}
				return rpc.call("open_project", { path: projectPath }, { timeoutMs: 120_000 });
			}
			case "GET /v1/editor/state":
				return rpc.call("get_state");
			case "POST /v1/editor/ops":
				return rpc.call("apply_ops", { ops: await prepareOps(bodyOf(request).ops, deps) });
			case "POST /v1/editor/undo":
				return rpc.call("undo");
			case "POST /v1/editor/redo":
				return rpc.call("redo");
			case "POST /v1/editor/save":
				return rpc.call("save", undefined, { timeoutMs: 120_000 });
			case "POST /v1/editor/seek":
				return rpc.call("seek", { timeMs: bodyOf(request).timeMs });
			case "POST /v1/editor/frame":
				return capturePreview(deps, bodyOf(request).timeMs);
			case "POST /v1/editor/transcript":
				return rpc.call(
					"transcript",
					{ refresh: bodyOf(request).refresh === true },
					{ timeoutMs: LONG_CALL_TIMEOUT_MS },
				);
			case "POST /v1/editor/captions/generate":
				return rpc.call("generate_captions", undefined, {
					timeoutMs: LONG_CALL_TIMEOUT_MS,
				});
			case "POST /v1/export": {
				const body = bodyOf(request);
				const target = await validateExportTarget(body);
				return rpc.call("start_export", {
					...target,
					quality: body.quality,
					fps: body.fps,
				});
			}
			case "GET /v1/export":
				return rpc.call("export_status");
			case "POST /v1/export/cancel":
				return rpc.call("cancel_export");
			default:
				throw new AutomationHttpError(404, `Unknown endpoint ${route}`, "not_found");
		}
	};
}
