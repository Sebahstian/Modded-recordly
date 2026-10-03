import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app, type BrowserWindow, ipcMain } from "electron";
import { readAppSetting, writeAppSetting } from "../appSettingsStore";
import { listProjectLibraryEntries } from "../ipc/project/manager";
import { currentProjectPath } from "../ipc/state";
import { approveUserPath } from "../ipc/utils";
import {
	AUTOMATION_BRIDGE_READY_CHANNEL,
	AUTOMATION_RESPONSE_CHANNEL,
	EditorRpc,
	type EditorRpcTarget,
} from "./editorRpc";
import { AUTOMATION_API_VERSION, createAutomationRouter } from "./routes";
import { type AutomationServer, startAutomationServer } from "./server";

/**
 * Local automation API: lets a local MCP server (and so Claude) drive the open
 * Recordly editor. Off by default; enabled from Settings → Advanced, or with
 * RECORDLY_AUTOMATION_API=1 for development.
 */

const SETTING_KEY = "automationApiEnabled";
const AUTOMATION_BRIDGE_GONE_CHANNEL = "automation-bridge-gone";
const DISCOVERY_FILE_NAME = "automation.json";

let server: AutomationServer | null = null;
let transition: Promise<unknown> = Promise.resolve();
let rpc: EditorRpc | null = null;
let initialized = false;

export interface AutomationApiStatus {
	enabled: boolean;
	running: boolean;
	port: number | null;
	discoveryFile: string;
	error?: string;
}

function getDiscoveryFilePath() {
	return path.join(app.getPath("userData"), DISCOVERY_FILE_NAME);
}

function envForcesAutomationApi() {
	return process.env.RECORDLY_AUTOMATION_API === "1";
}

export function getAutomationApiEnabled() {
	return envForcesAutomationApi() || readAppSetting(SETTING_KEY) === true;
}

export function getAutomationApiStatus(): AutomationApiStatus {
	return {
		enabled: getAutomationApiEnabled(),
		running: server !== null,
		port: server?.port ?? null,
		discoveryFile: getDiscoveryFilePath(),
	};
}

function toTarget(win: BrowserWindow): EditorRpcTarget {
	const { webContents } = win;
	return {
		id: webContents.id,
		send: (channel, payload) => webContents.send(channel, payload),
		isDestroyed: () => win.isDestroyed() || webContents.isDestroyed(),
		capture: async (rect, maxWidth) => {
			const image = await webContents.capturePage({
				x: Math.max(0, Math.round(rect.x)),
				y: Math.max(0, Math.round(rect.y)),
				width: Math.max(1, Math.round(rect.width)),
				height: Math.max(1, Math.round(rect.height)),
			});
			const { width } = image.getSize();
			const scaled =
				width > maxWidth ? image.resize({ width: maxWidth, quality: "good" }) : image;
			return scaled.toJPEG(85);
		},
	};
}

async function writeDiscoveryFile(running: AutomationServer) {
	const filePath = getDiscoveryFilePath();
	const payload = {
		app: "Recordly",
		apiVersion: AUTOMATION_API_VERSION,
		appVersion: app.getVersion(),
		url: `http://127.0.0.1:${running.port}`,
		port: running.port,
		token: running.token,
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	// `mode` only applies on creation; tighten an existing file too.
	await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function removeDiscoveryFile() {
	await fs.rm(getDiscoveryFilePath(), { force: true }).catch(() => undefined);
}

async function startServer(deps: AutomationApiDeps) {
	if (server || !rpc) return;
	const editorRpc = rpc;
	const started = await startAutomationServer({
		handle: createAutomationRouter({
			rpc: editorRpc,
			appVersion: app.getVersion(),
			getCurrentProjectPath: () => currentProjectPath,
			listProjects: async () => {
				const library = await listProjectLibraryEntries();
				return {
					projectsDir: library.projectsDir,
					projects: library.entries.map((entry) => ({
						path: entry.path,
						name: entry.name,
						updatedAt: new Date(entry.updatedAt).toISOString(),
						isCurrent: entry.isCurrent,
					})),
				};
			},
			openEditorWindow: deps.openEditorWindow,
			approveReadPath: async (filePath) => approveUserPath(filePath),
		}),
	});
	server = started;
	await writeDiscoveryFile(started);
	console.log(`[automation-api] Listening on 127.0.0.1:${started.port}`);
}

async function stopServer() {
	const running = server;
	server = null;
	await removeDiscoveryFile();
	if (running) {
		await running.close();
		console.log("[automation-api] Stopped");
	}
}

export interface AutomationApiDeps {
	/** Editor windows, most relevant first. */
	getEditorWindows(): BrowserWindow[];
	openEditorWindow(): void;
}

let savedDeps: AutomationApiDeps | null = null;

/** Register IPC listeners and start the API if the user enabled it. */
export async function initAutomationApi(deps: AutomationApiDeps) {
	savedDeps = deps;
	if (!initialized) {
		initialized = true;
		const editorRpc = new EditorRpc(() => deps.getEditorWindows().map(toTarget));
		rpc = editorRpc;
		const watchedSenders = new Set<number>();
		ipcMain.on(AUTOMATION_BRIDGE_READY_CHANNEL, (event) => {
			const { sender } = event;
			const senderId = sender.id;
			editorRpc.markReady(senderId);
			if (watchedSenders.has(senderId)) return;
			watchedSenders.add(senderId);
			sender.once("destroyed", () => {
				watchedSenders.delete(senderId);
				editorRpc.markGone(senderId);
			});
		});
		ipcMain.on(AUTOMATION_BRIDGE_GONE_CHANNEL, (event) => editorRpc.markGone(event.sender.id));
		ipcMain.on(AUTOMATION_RESPONSE_CHANNEL, (event, response: unknown) =>
			editorRpc.handleResponse(event.sender.id, response),
		);
		ipcMain.handle("get-automation-api-status", () => getAutomationApiStatus());
		ipcMain.handle("set-automation-api-enabled", async (_event, enabled: unknown) => {
			if (typeof enabled !== "boolean") {
				return { success: false, ...getAutomationApiStatus(), error: "Invalid value" };
			}
			try {
				await setAutomationApiEnabled(enabled);
				return { success: true, ...getAutomationApiStatus() };
			} catch (error) {
				return { success: false, ...getAutomationApiStatus(), error: String(error) };
			}
		});
	}
	if (getAutomationApiEnabled()) {
		transition = transition.then(() => startServer(deps));
		await transition.catch((error) => {
			console.warn("[automation-api] Failed to start:", error);
		});
	} else {
		// A crash can leave a stale discovery file behind; never advertise a dead server.
		await removeDiscoveryFile();
	}
}

export async function setAutomationApiEnabled(enabled: boolean) {
	writeAppSetting(SETTING_KEY, enabled);
	const deps = savedDeps;
	transition = transition
		.catch(() => undefined)
		.then(() =>
			(enabled || envForcesAutomationApi()) && deps ? startServer(deps) : stopServer(),
		);
	await transition;
}

export async function shutdownAutomationApi() {
	// Quit doesn't wait for promises: drop the discovery file synchronously first so
	// clients never find a token for a server that is going away.
	try {
		rmSync(getDiscoveryFilePath(), { force: true });
	} catch {
		// Best effort.
	}
	transition = transition.catch(() => undefined).then(stopServer);
	await transition;
}
