import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoveryCandidates,
	RecordlyApiError,
	RecordlyClient,
	resolveConnection,
} from "./client.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "recordly-mcp-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function fakeApi(handler: (auth: string | undefined, url: string) => [number, unknown]) {
	const server: Server = createServer((req, res) => {
		const [status, body] = handler(req.headers.authorization, req.url ?? "");
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("discoveryCandidates", () => {
	it("uses each platform's app-data folder", () => {
		expect(discoveryCandidates("darwin", {}, "/Users/a")[0]).toBe(
			"/Users/a/Library/Application Support/Recordly/automation.json",
		);
		expect(discoveryCandidates("linux", {}, "/home/a")).toEqual([
			"/home/a/.config/Recordly/automation.json",
			"/home/a/.config/Recordly-dev/automation.json",
		]);
		expect(
			discoveryCandidates(
				"win32",
				{ APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
				"C:\\Users\\a",
			)[0],
		).toContain("Recordly");
	});
});

describe("resolveConnection", () => {
	it("prefers explicit environment variables", async () => {
		await expect(
			resolveConnection({ RECORDLY_API_URL: "http://127.0.0.1:1", RECORDLY_API_TOKEN: "t" }),
		).resolves.toMatchObject({ url: "http://127.0.0.1:1", token: "t", source: "environment" });
	});

	it("reads the discovery file and ignores dead processes", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "automation.json");
		await writeFile(
			file,
			JSON.stringify({ url: "http://127.0.0.1:2", token: "abc", pid: process.pid }),
		);
		await expect(resolveConnection({ RECORDLY_DISCOVERY_FILE: file })).resolves.toMatchObject({
			url: "http://127.0.0.1:2",
			token: "abc",
		});
		await writeFile(
			file,
			JSON.stringify({ url: "http://127.0.0.1:2", token: "abc", pid: 2 ** 22 + 7 }),
		);
		await expect(resolveConnection({ RECORDLY_DISCOVERY_FILE: file })).rejects.toMatchObject({
			code: "not_running",
		});
	});
});

describe("RecordlyClient", () => {
	it("sends the token and unwraps results", async () => {
		const url = await fakeApi((auth) =>
			auth === "Bearer secret"
				? [200, { ok: true, result: { hello: 1 } }]
				: [401, { ok: false }],
		);
		const client = new RecordlyClient({ RECORDLY_API_URL: url, RECORDLY_API_TOKEN: "secret" });
		await expect(client.get("/v1/status")).resolves.toEqual({ hello: 1 });
	});

	it("surfaces API errors with their code", async () => {
		const url = await fakeApi(() => [
			409,
			{ ok: false, error: { code: "no_editor", message: "No Recordly editor is open." } },
		]);
		const client = new RecordlyClient({ RECORDLY_API_URL: url, RECORDLY_API_TOKEN: "x" });
		const error = await client.get("/v1/editor/state").catch((caught) => caught);
		expect(error).toBeInstanceOf(RecordlyApiError);
		expect(error).toMatchObject({ code: "no_editor", status: 409 });
	});

	it("explains how to enable the API when Recordly is not running", async () => {
		const client = new RecordlyClient({
			RECORDLY_API_URL: "http://127.0.0.1:9",
			RECORDLY_API_TOKEN: "x",
		});
		await expect(client.get("/v1/status")).rejects.toThrow(/Allow local API control/);
	});
});
