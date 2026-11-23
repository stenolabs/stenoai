import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/electron";

// The mock has no transcription model, so Home redirects to onboarding; start
// from Chat (a normal shell route) and use the real sidebar entry point.
async function openCookbooks(page: Page) {
  await page.evaluate(() => {
    window.location.hash = "#/chat";
  });
  await page.getByRole("button", { name: /^Cookbooks/ }).click();
}

// Cookbooks: the gallery over the existing note templates. Drives the real
// renderer against the mock IPC template list (e2e-mock-ipc.js), which carries
// the shipped built-ins, a locked Standard, and user-created templates.

test("Cookbooks opens from the sidebar and renders featured + category sections", async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true, releaseHighlightsSeen: true });

  await openCookbooks(page);
  await expect(page.getByRole("heading", { level: 1, name: "Cookbooks" })).toBeVisible();
  await expect(page.getByText("Let's cook!")).toBeVisible();
  // Sits right after Connect in the sidebar, marked New.
  const entry = page.getByRole("button", { name: /^Cookbooks/ });
  await expect(entry).toHaveAttribute("aria-current", "page");
  await expect(entry).toContainText("New");

  const featured = page.getByRole("region", { name: "Featured" });
  for (const name of ["Sales Call", "1:1", "Product Demo", "Standup"]) {
    await expect(featured.getByRole("button", { name, exact: true })).toBeVisible();
  }

  for (const [section, member] of [
    ["Briefings & decisions", "Shareable summary"],
    ["Calls & interviews", "Sales Call"],
    ["Planning & reviews", "1:1 Notes"],
    ["Everyday meetings", "Standup"],
  ]) {
    const region = page.getByRole("region", { name: section, exact: true });
    await expect(region.getByRole("button", { name: member, exact: true })).toBeVisible();
  }

  // Featured row is keyboard navigable: arrows move focus card to card.
  const cards = featured.locator("[data-featured-card]");
  await cards.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(cards.last()).toBeFocused();
});

test("Cookbooks search and category filter narrow the gallery", async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, releaseHighlightsSeen: true });
  await openCookbooks(page);

  const search = page.getByRole("searchbox", { name: "Search cookbooks" });
  await search.fill("standup");
  await expect(page.getByText("1 cookbook", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Standup", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sales Call", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Featured" })).toHaveCount(0);

  await search.fill("no such cookbook");
  await expect(page.getByText("No cookbooks match your search.")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("region", { name: "Featured" })).toBeVisible();

  await page.getByRole("combobox", { name: "Filter by category" }).click();
  await page.getByRole("option", { name: "Calls & interviews" }).click();
  await expect(page.getByText("2 cookbooks", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Product Demo", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Standup", exact: true })).toHaveCount(0);

  // My cookbooks only shows user-created templates.
  await page.getByRole("combobox", { name: "Filter by category" }).click();
  await page.getByRole("option", { name: "All categories" }).click();
  await page.getByRole("tab", { name: /My cookbooks/ }).click();
  await expect(page.getByRole("button", { name: "1:1 Notes", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Shareable summary", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sales Call", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Organisation" })).toHaveCount(0);
});

test("Cookbook cards open the cookbook editor; Create opens it blank", async ({
  launchApp,
}) => {
  const { page, app } = await launchApp({ mockIpc: true, releaseHighlightsSeen: true });
  await openCookbooks(page);

  await page
    .getByRole("region", { name: "Calls & interviews", exact: true })
    .getByRole("button", { name: "Sales Call", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Edit cookbook" })).toBeVisible();
  await expect(page.getByPlaceholder(/Weekly Sync/)).toHaveValue("Sales Call");
  // A built-in can be set as default but not deleted.
  await expect(page.getByRole("button", { name: "Set as default", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Delete cookbook/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to cookbooks" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cookbooks" })).toBeVisible();

  // The locked built-in opens read-only: viewable and defaultable, not editable.
  await page
    .getByRole("region", { name: "Featured" })
    .getByRole("button", { name: "Standard Summary", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Built-in cookbook" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save cookbook", exact: true })).toHaveCount(0);
  // Standard is the mock's default: shown as such, with no Set as default.
  await expect(page.getByText("Default", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set as default", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to cookbooks" }).click();

  // A user cookbook: set as default and delete both go through the bridge.
  await page.getByRole("tab", { name: /My cookbooks/ }).click();
  await page.getByRole("button", { name: "1:1 Notes", exact: true }).click();
  await page.getByRole("button", { name: "Set as default", exact: true }).click();
  await page.getByRole("button", { name: "Delete cookbook 1:1 Notes" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText('Delete cookbook "1:1 Notes"?')).toBeVisible();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cookbooks" })).toBeVisible();
  const calls = await app.evaluate(
    () => (global as unknown as { __mockIpcCalls: string[] }).__mockIpcCalls,
  );
  expect(calls).toEqual(expect.arrayContaining(["set-default-template", "delete-template"]));

  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("menuitem", { name: /^New cookbook/ }).click();
  await expect(page.getByRole("heading", { name: "New cookbook" })).toBeVisible();
  await expect(page.getByPlaceholder(/Weekly Sync/)).toHaveValue("");
});

test("The old Settings → Templates deep link lands on Cookbooks", async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, releaseHighlightsSeen: true });
  await page.evaluate(() => {
    window.location.hash = "#/settings?tab=templates";
  });
  await expect(page.getByRole("heading", { level: 1, name: "Cookbooks" })).toBeVisible();
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
});

test("The cookbooks intro card dismisses and stays dismissed", async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true, releaseHighlightsSeen: true });
  await openCookbooks(page);
  const intro = page.getByRole("region", { name: "What's a cookbook?" });
  await expect(intro).toBeVisible();
  await intro.getByRole("button", { name: "Dismiss" }).click();
  await expect(intro).toHaveCount(0);

  await openCookbooks(page);
  await expect(page.getByRole("heading", { level: 1, name: "Cookbooks" })).toBeVisible();
  await expect(page.getByRole("region", { name: "What's a cookbook?" })).toHaveCount(0);
});
