import { randomUUID } from "node:crypto";
import { AutomationHttpError } from "./server";

/**
 * Request/response bridge from the main process to the editor renderer.
 *
 * The renderer owns all editor state, so every editing call is forwarded to its
 * `useAutomationBridge` hook over IPC and the reply is matched back by id.
 */

export const AUTOMATION_REQUEST_CHANNEL = "automation-request";
export const AUTOMATION_RESPONSE_CHANNEL = "automation-response";
export const AUTOMATION_BRIDGE_READY_CHANNEL = "automation-bridge-ready";

export interface CaptureRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface EditorRpcTarget {
	id: number;
	send(channel: string, payload: unknown): void;
	isDestroyed(): boolean;
	/** Screenshot part of the editor window as a JPEG, at most `maxWidth` pixels wide. */
	capture?(rect: CaptureRect, maxWidth: number): Promise<Buffer>;
}

export interface EditorRpcRequest {
	id: string;
	method: string;
	params: unknown;
}

export interface EditorRpcResponse {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: { message: string; code?: string };
}

type Pending = {
	targetId: number;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};

export const DEFAULT_EDITOR_RPC_TIMEOUT_MS = 30_000;

export class EditorRpc {
	private readonly pending = new Map<string, Pending>();
	private readonly readyTargets = new Set<number>();
	private readonly readyWaiters = new Set<() => void>();

	constructor(private readonly getTargets: () => EditorRpcTarget[]) {}

	markReady(targetId: number) {
		this.readyTargets.add(targetId);
		for (const wake of [...this.readyWaiters]) wake();
	}

	markGone(targetId: number) {
		this.readyTargets.delete(targetId);
		for (const [id, pending] of this.pending) {
			if (pending.targetId !== targetId) continue;
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(
				new AutomationHttpError(409, "The editor window closed", "editor_closed"),
			);
		}
	}

	/** The editor that will receive calls: the first ready, live target. */
	getReadyTarget(): EditorRpcTarget | null {
		return (
			this.getTargets().find(
				(target) => !target.isDestroyed() && this.readyTargets.has(target.id),
			) ?? null
		);
	}

	hasReadyEditor() {
		return this.getReadyTarget() !== null;
	}

	async waitForReady(timeoutMs: number): Promise<EditorRpcTarget> {
		const existing = this.getReadyTarget();
		if (existing) return existing;
		return new Promise((resolve, reject) => {
			const wake = () => {
				const target = this.getReadyTarget();
				if (!target) return;
				cleanup();
				resolve(target);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(
					new AutomationHttpError(
						504,
						"Timed out waiting for the editor to open",
						"timeout",
					),
				);
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				this.readyWaiters.delete(wake);
			};
			this.readyWaiters.add(wake);
		});
	}

	handleResponse(senderId: number, response: unknown) {
		if (!response || typeof response !== "object") return;
		const { id, ok, result, error } = response as Partial<EditorRpcResponse>;
		if (typeof id !== "string") return;
		const pending = this.pending.get(id);
		if (!pending || pending.targetId !== senderId) return;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		if (ok) {
			pending.resolve(result);
			return;
		}
		pending.reject(
			new AutomationHttpError(
				error?.code === "busy" ? 409 : 422,
				error?.message || "The editor rejected the request",
				error?.code || "editor_error",
			),
		);
	}

	call(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
		const target = this.getReadyTarget();
		if (!target) {
			return Promise.reject(
				new AutomationHttpError(
					409,
					"No Recordly editor is open. Open a project (open_project) or a recording first.",
					"no_editor",
				),
			);
		}
		const id = randomUUID();
		const timeoutMs = options.timeoutMs ?? DEFAULT_EDITOR_RPC_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new AutomationHttpError(
						504,
						`The editor did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`,
						"timeout",
					),
				);
			}, timeoutMs);
			this.pending.set(id, { targetId: target.id, resolve, reject, timer });
			const request: EditorRpcRequest = { id, method, params: params ?? null };
			try {
				target.send(AUTOMATION_REQUEST_CHANNEL, request);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}
