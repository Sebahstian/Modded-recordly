import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local HTTP server for the automation API (Claude / MCP control).
 *
 * Only reachable from this machine and only with the bearer token written to the
 * discovery file. Browser-originated requests are rejected outright (any `Origin`
 * header, or a `Host` that isn't the loopback address we bound) so a web page
 * can't drive the editor through CSRF or DNS rebinding.
 */

export const AUTOMATION_MAX_BODY_BYTES = 10 * 1024 * 1024;

export class AutomationHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = "error",
	) {
		super(message);
		this.name = "AutomationHttpError";
	}
}

export interface AutomationRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	body: unknown;
}

export type AutomationRouteHandler = (request: AutomationRequest) => Promise<unknown>;

export interface AutomationServer {
	port: number;
	token: string;
	close(): Promise<void>;
}

export function createAutomationToken() {
	return randomBytes(32).toString("base64url");
}

function tokensMatch(expected: string, header: string | undefined) {
	if (!header?.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice("Bearer ".length).trim());
	const wanted = Buffer.from(expected);
	return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > AUTOMATION_MAX_BODY_BYTES) {
			throw new AutomationHttpError(413, "Request body is too large", "body_too_large");
		}
		chunks.push(buffer);
	}
	if (size === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
	} catch {
		throw new AutomationHttpError(400, "Request body must be valid JSON", "invalid_json");
	}
}

export function isAllowedAutomationHost(host: string | undefined, port: number) {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export async function startAutomationServer(options: {
	token?: string;
	port?: number;
	handle: AutomationRouteHandler;
}): Promise<AutomationServer> {
	const token = options.token ?? createAutomationToken();
	let port = 0;
	const server: Server = createServer((req, res) => {
		void (async () => {
			try {
				if (req.headers.origin !== undefined) {
					throw new AutomationHttpError(
						403,
						"Browser requests are not allowed",
						"forbidden",
					);
				}
				if (!isAllowedAutomationHost(req.headers.host, port)) {
					throw new AutomationHttpError(403, "Unexpected Host header", "forbidden");
				}
				if (!tokensMatch(token, req.headers.authorization)) {
					throw new AutomationHttpError(
						401,
						"Missing or invalid API token",
						"unauthorized",
					);
				}
				const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
				const method = req.method ?? "GET";
				const body =
					method === "GET" || method === "HEAD" ? undefined : await readJsonBody(req);
				const result = await options.handle({
					method,
					path: url.pathname.replace(/\/+$/, "") || "/",
					query: url.searchParams,
					body,
				});
				sendJson(res, 200, { ok: true, result: result ?? null });
			} catch (error) {
				const status = error instanceof AutomationHttpError ? error.status : 500;
				const code = error instanceof AutomationHttpError ? error.code : "internal_error";
				const message = error instanceof Error ? error.message : String(error);
				if (status >= 500) console.error("[automation-api]", error);
				if (!res.headersSent)
					sendJson(res, status, { ok: false, error: { code, message } });
				else res.end();
			}
		})();
	});
	server.requestTimeout = 15 * 60 * 1000;

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	port = (server.address() as AddressInfo).port;

	return {
		port,
		token,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			}),
	};
}
