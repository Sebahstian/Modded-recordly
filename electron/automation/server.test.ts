import { request as httpRequest } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTOMATION_REQUEST_CHANNEL,
	EditorRpc,
	type EditorRpcRequest,
	type EditorRpcTarget,
} from "./editorRpc";
import { createAutomationRouter, resolveUserPath, validateExportTarget } from "./routes";
import { type AutomationServer, startAutomationServer } from "./server";

let running: AutomationServer | null = null;

afterEach(async () => {
	await running?.close();
	running = null;
});

function call(
	server: AutomationServer,
	options: {
		method?: string;
		path?: string;
		token?: string | null;
		headers?: Record<string, string>;
		body?: unknown;
	} = {},
) {
	return new Promise<{
		status: number;
		json: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
	}>((resolve, reject) => {
		const body = options.body === undefined ? undefined : JSON.stringify(options.body);
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port: server.port,
				method: options.method ?? "GET",
				path: options.path ?? "/v1/status",
				headers: {
					...(options.token === null
						? {}
						: { Authorization: `Bearer ${options.token ?? server.token}` }),
					...(body ? { "Content-Type": "application/json" } : {}),
					...options.headers,
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }),
				);
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

function fakeEditor(id = 1) {
	const sent: EditorRpcRequest[] = [];
	const target: EditorRpcTarget = {
		id,
		send: (channel, payload) => {
			expect(channel).toBe(AUTOMATION_REQUEST_CHANNEL);
			sent.push(payload as EditorRpcRequest);
		},
		isDestroyed: () => false,
	};
	return { target, sent };
}

async function startWithRouter(rpc: EditorRpc) {
	running = await startAutomationServer({
		handle: createAutomationRouter({
			rpc,
			appVersion: "1.0.0-test",
			getCurrentProjectPath: () => "/tmp/demo.recordly",
			listProjects: async () => ({ projects: [] }),
			openEditorWindow: () => undefined,
			approveReadPath: async () => undefined,
		}),
	});
	return running;
}

describe("automation server", () => {
	it("requires the bearer token", async () => {
		const server = await startWithRouter(new EditorRpc(() => []));
		expect((await call(server, { token: null })).status).toBe(401);
		expect((await call(server, { token: "wrong" })).status).toBe(401);
		const ok = await call(server);
		expect(ok.status).toBe(200);
		expect(ok.json.result).toMatchObject({ app: "Recordly", editorOpen: false });
	});

	it("rejects browser and DNS-rebinding requests", async () => {
		const server = await startWithRouter(new EditorRpc(() => []));
		expect((await call(server, { headers: { Origin: "https://evil.example" } })).status).toBe(
			403,
		);
		expect(
			(await call(server, { headers: { Host: `evil.example:${server.port}` } })).status,
		).toBe(403);
	});

	it("returns 409 for editor calls when no editor is open", async () => {
		const server = await startWithRouter(new EditorRpc(() => []));
		const response = await call(server, { path: "/v1/editor/state" });
		expect(response.status).toBe(409);
		expect(response.json.error.code).toBe("no_editor");
	});

	it("forwards editor calls and returns the editor's answer", async () => {
		const editor = fakeEditor();
		const rpc = new EditorRpc(() => [editor.target]);
		rpc.markReady(editor.target.id);
		const server = await startWithRouter(rpc);
		const pending = call(server, {
			method: "POST",
			path: "/v1/editor/ops",
			body: { ops: [{ op: "add_zoom", startMs: 0, endMs: 1000 }] },
		});
		await expect.poll(() => editor.sent.length).toBe(1);
		expect(editor.sent[0]).toMatchObject({ method: "apply_ops" });
		rpc.handleResponse(editor.target.id, {
			id: editor.sent[0].id,
			ok: true,
			result: { applied: 1 },
		});
		const response = await pending;
		expect(response.status).toBe(200);
		expect(response.json.result).toEqual({ applied: 1 });
	});

	it("reports editor validation errors as 422", async () => {
		const editor = fakeEditor();
		const rpc = new EditorRpc(() => [editor.target]);
		rpc.markReady(editor.target.id);
		const server = await startWithRouter(rpc);
		const pending = call(server, { path: "/v1/editor/state" });
		await expect.poll(() => editor.sent.length).toBe(1);
		rpc.handleResponse(editor.target.id, {
			id: editor.sent[0].id,
			ok: false,
			error: { message: "bad op", code: "invalid_op" },
		});
		const response = await pending;
		expect(response.status).toBe(422);
		expect(response.json.error).toEqual({ code: "invalid_op", message: "bad op" });
	});

	it("rejects malformed JSON", async () => {
		const server = await startWithRouter(new EditorRpc(() => []));
		const response = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: server.port,
					method: "POST",
					path: "/v1/editor/ops",
					headers: { Authorization: `Bearer ${server.token}` },
				},
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				},
			);
			req.on("error", reject);
			req.end("{not json");
		});
		expect(response).toBe(400);
	});
});

describe("EditorRpc", () => {
	it("times out when the editor does not answer", async () => {
		const editor = fakeEditor();
		const rpc = new EditorRpc(() => [editor.target]);
		rpc.markReady(editor.target.id);
		await expect(rpc.call("get_state", undefined, { timeoutMs: 20 })).rejects.toMatchObject({
			status: 504,
		});
	});

	it("ignores responses from a different window", async () => {
		const editor = fakeEditor(1);
		const rpc = new EditorRpc(() => [editor.target]);
		rpc.markReady(1);
		const pending = rpc.call("get_state", undefined, { timeoutMs: 50 });
		rpc.handleResponse(2, { id: editor.sent[0].id, ok: true, result: "spoofed" });
		await expect(pending).rejects.toMatchObject({ status: 504 });
	});

	it("fails pending calls when the editor closes", async () => {
		const editor = fakeEditor(1);
		const rpc = new EditorRpc(() => [editor.target]);
		rpc.markReady(1);
		const pending = rpc.call("get_state");
		rpc.markGone(1);
		await expect(pending).rejects.toMatchObject({ code: "editor_closed" });
		expect(rpc.hasReadyEditor()).toBe(false);
	});

	it("waits for an editor to become ready", async () => {
		const editor = fakeEditor(3);
		const rpc = new EditorRpc(() => [editor.target]);
		const waiting = rpc.waitForReady(1000);
		rpc.markReady(3);
		await expect(waiting).resolves.toBe(editor.target);
	});
});

describe("route helpers", () => {
	it("expands ~ and requires absolute paths", () => {
		expect(resolveUserPath("~/out.mp4", "outputPath")).toBe(path.join(os.homedir(), "out.mp4"));
		expect(() => resolveUserPath("out.mp4", "outputPath")).toThrow(/absolute/);
	});

	it("validates export targets", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-automation-"));
		try {
			const outputPath = path.join(dir, "out.mp4");
			await expect(validateExportTarget({ outputPath })).resolves.toEqual({
				format: "mp4",
				outputPath,
			});
			await expect(validateExportTarget({ format: "gif", outputPath })).rejects.toThrow(
				/\.gif/,
			);
			await expect(
				validateExportTarget({ outputPath: path.join(dir, "missing", "out.mp4") }),
			).rejects.toThrow(/does not exist/);
			await fs.writeFile(outputPath, "x");
			await expect(validateExportTarget({ outputPath })).rejects.toThrow(/already exists/);
			await expect(
				validateExportTarget({ outputPath, overwrite: true }),
			).resolves.toBeTruthy();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
