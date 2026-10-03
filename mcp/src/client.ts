import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Finds the running Recordly app and talks to its local automation API.
 *
 * Recordly writes `automation.json` (URL + bearer token) into its user-data
 * folder while "Allow local API control" is on. The file is re-read on every
 * request, so restarting Recordly never leaves the MCP server with a stale port.
 */

export interface Connection {
	url: string;
	token: string;
	source: string;
}

interface DiscoveryFile {
	url?: unknown;
	token?: unknown;
	pid?: unknown;
	startedAt?: unknown;
}

export class RecordlyApiError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "RecordlyApiError";
	}
}

const NOT_RUNNING_HELP =
	"Recordly isn't reachable. Open the Recordly app and turn on Settings → Advanced → " +
	'"Allow local API control", then try again.';

/** Where Recordly's user-data folder lives for each platform (release and dev builds). */
export function discoveryCandidates(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home = os.homedir(),
): string[] {
	const appData =
		platform === "darwin"
			? path.join(home, "Library", "Application Support")
			: platform === "win32"
				? (env.APPDATA ?? path.join(home, "AppData", "Roaming"))
				: (env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
	return ["Recordly", "Recordly-dev"].map((name) => path.join(appData, name, "automation.json"));
}

function isProcessAlive(pid: unknown) {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readDiscoveryFile(filePath: string) {
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf-8")) as DiscoveryFile;
		if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return null;
		if (!isProcessAlive(parsed.pid)) return null;
		return {
			url: parsed.url,
			token: parsed.token,
			source: filePath,
			startedAt: typeof parsed.startedAt === "string" ? Date.parse(parsed.startedAt) : 0,
		};
	} catch {
		return null;
	}
}

export async function resolveConnection(env: NodeJS.ProcessEnv = process.env): Promise<Connection> {
	if (env.RECORDLY_API_URL && env.RECORDLY_API_TOKEN) {
		return { url: env.RECORDLY_API_URL, token: env.RECORDLY_API_TOKEN, source: "environment" };
	}
	const files = env.RECORDLY_DISCOVERY_FILE
		? [env.RECORDLY_DISCOVERY_FILE]
		: discoveryCandidates();
	const found = (await Promise.all(files.map(readDiscoveryFile)))
		.filter((entry) => entry !== null)
		.sort((left, right) => right.startedAt - left.startedAt);
	if (found.length === 0) throw new RecordlyApiError(NOT_RUNNING_HELP, "not_running");
	const { url, token, source } = found[0];
	return { url, token, source };
}

export interface RequestOptions {
	timeoutMs?: number;
}

export class RecordlyClient {
	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	async request<T = unknown>(
		method: "GET" | "POST",
		endpoint: string,
		body?: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		const connection = await resolveConnection(this.env);
		let response: Response;
		try {
			response = await fetch(new URL(endpoint, connection.url), {
				method,
				headers: {
					Authorization: `Bearer ${connection.token}`,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
			});
		} catch (error) {
			if ((error as Error).name === "TimeoutError") {
				throw new RecordlyApiError(
					`Recordly did not answer ${endpoint} in time`,
					"timeout",
				);
			}
			throw new RecordlyApiError(NOT_RUNNING_HELP, "not_running");
		}
		let payload: { ok?: boolean; result?: T; error?: { code?: string; message?: string } };
		try {
			payload = (await response.json()) as typeof payload;
		} catch {
			throw new RecordlyApiError(
				`Recordly returned an unreadable response (HTTP ${response.status})`,
				"bad_response",
				response.status,
			);
		}
		if (!response.ok || !payload.ok) {
			throw new RecordlyApiError(
				payload.error?.message ?? `Request failed with HTTP ${response.status}`,
				payload.error?.code ?? "error",
				response.status,
			);
		}
		return payload.result as T;
	}

	get<T = unknown>(endpoint: string, options?: RequestOptions) {
		return this.request<T>("GET", endpoint, undefined, options);
	}

	post<T = unknown>(endpoint: string, body?: unknown, options?: RequestOptions) {
		return this.request<T>("POST", endpoint, body ?? {}, options);
	}
}
