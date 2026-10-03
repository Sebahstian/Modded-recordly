import { expect, type Page, test } from "@playwright/test";
import { installDesktopBridge, installDesktopBridgeOverrides } from "./bridge";

type AutomationResponse = {
	id: string;
	ok: boolean;
	result?: Record<string, unknown>;
	error?: { message: string; code?: string };
};

type AutomationWindow = Window & {
	__automationHandler?: ((request: unknown) => Promise<void>) | null;
	__automationResponses?: AutomationResponse[];
	__automationToggles?: boolean[];
};

const clipsFor = (page: Page) => page.locator('[data-variant="clip"]');
const zoomsFor = (page: Page) => page.locator('[data-variant="zoom"]');

async function clickSwitch(page: Page, name: string) {
	await page
		.locator('[data-slot="switch"]')
		.filter({ has: page.getByRole("switch", { name, exact: true }) })
		.locator('[data-slot="switch-control"]')
		.click();
}

/** Send one request the way the main process does and wait for the editor's reply. */
async function automation(page: Page, method: string, params: Record<string, unknown> = {}) {
	return page.evaluate(
		async ({ method, params }) => {
			const target = window as AutomationWindow;
			const id = `${method}-${Math.random()}`;
			if (!target.__automationHandler) throw new Error("automation bridge is not registered");
			await target.__automationHandler({ id, method, params });
			return target.__automationResponses?.find((response) => response.id === id) ?? null;
		},
		{ method, params },
	);
}

test.beforeEach(async ({ page }) => {
	await installDesktopBridge(page, "filmstrip.mp4");
	await installDesktopBridgeOverrides(page, () => {
		const target = window as AutomationWindow;
		target.__automationResponses = [];
		target.__automationToggles = [];
		const status = (enabled: boolean) => ({
			enabled,
			running: enabled,
			port: enabled ? 45123 : null,
			discoveryFile: "/user-data/automation.json",
		});
		Object.assign(window.electronAPI, {
			getAutomationApiStatus: async () => status(false),
			setAutomationApiEnabled: async (enabled: boolean) => {
				target.__automationToggles?.push(enabled);
				return { success: true, ...status(enabled) };
			},
			onAutomationRequest: (callback: (request: unknown) => Promise<void>) => {
				target.__automationHandler = callback;
				return () => {
					target.__automationHandler = null;
				};
			},
			sendAutomationResponse: (response: AutomationResponse) => {
				target.__automationResponses?.push(response);
			},
		});
	});
	await page.goto("/?windowType=editor");
	await expect(clipsFor(page)).toHaveAttribute("data-end-ms", "6000", { timeout: 20000 });
});

test("an automation batch edits the live timeline as one undo step", async ({ page }) => {
	const state = await automation(page, "get_state");
	expect(state?.ok).toBe(true);
	expect(state?.result).toMatchObject({ ready: true, timeline: { timelineDurationMs: 6000 } });

	const applied = await automation(page, "apply_ops", {
		ops: [
			{ op: "cut_range", startMs: 1000, endMs: 2000 },
			{ op: "add_zoom", startMs: 3000, endMs: 4000, depth: 4 },
		],
	});
	expect(applied?.ok).toBe(true);
	await expect(clipsFor(page)).toHaveCount(2);
	await expect(clipsFor(page).last()).toHaveAttribute("data-end-ms", "5000");
	await expect(zoomsFor(page)).toHaveCount(1);

	const undone = await automation(page, "undo");
	expect(undone?.result).toMatchObject({ timeline: { timelineDurationMs: 6000 } });
	await expect(clipsFor(page)).toHaveCount(1);
	await expect(zoomsFor(page)).toHaveCount(0);

	const redone = await automation(page, "redo");
	expect(redone?.result).toMatchObject({ timeline: { timelineDurationMs: 5000 } });
	await expect(zoomsFor(page)).toHaveCount(1);
});

test("an invalid automation batch changes nothing", async ({ page }) => {
	const rejected = await automation(page, "apply_ops", {
		ops: [
			{ op: "add_zoom", startMs: 1000, endMs: 3000 },
			{ op: "add_zoom", startMs: 2000, endMs: 4000 },
		],
	});
	expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_op" } });
	expect(rejected?.error?.message).toContain("ops[1]");
	await expect(zoomsFor(page)).toHaveCount(0);
	await expect(clipsFor(page)).toHaveCount(1);
});

test("the local API can be switched on from advanced settings", async ({ page }) => {
	await page.getByRole("radio", { name: "Settings", exact: true }).click();
	await clickSwitch(page, "Advanced settings");
	await page
		.locator('[aria-label="Settings sections"]')
		.getByText("Advanced", { exact: true })
		.click();
	const toggle = page.getByRole("switch", { name: "Allow local API control", exact: true });
	await expect(toggle).not.toBeChecked();
	await clickSwitch(page, "Allow local API control");
	await expect(toggle).toBeChecked();
	await expect(page.getByText("Running on port 45123")).toBeVisible();
	expect(await page.evaluate(() => (window as AutomationWindow).__automationToggles)).toEqual([
		true,
	]);
});
