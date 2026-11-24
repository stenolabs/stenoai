import { writeFileSync } from "node:fs";
import { test, expect } from "../fixtures/electron";
import type {
  ChatSessionsBlob,
  StenoaiBridge,
} from "../../app/renderer/src/lib/ipc";

for (const type of ["bar", "line"]) {
  test(`${type} chart reopens from saved chat and shows its data; invalid chart stays readable`, async ({
    launchApp,
  }, testInfo) => {
    const spec = {
      type,
      title: "Actions by meeting",
      xLabel: "Meeting",
      yLabel: "Action items",
      data: [
        { label: "Planning", value: 3 },
        { label: "Review", value: type === "line" ? 1000000000000 : 5 },
      ],
    };
    const answer =
      "From Planning and Review.\n\n```steno-chart\n" +
      JSON.stringify(spec) +
      '\n```\n\n```steno-chart\n{"type":"unsupported"}\n```';
    const session = {
      id: "chart-session",
      name: "Meeting actions",
      summaryFile: "__global__",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        { role: "user", content: "Chart my action items", ts: Date.now() },
        { role: "assistant", content: answer, ts: Date.now() },
      ],
    };
    const { page } = await launchApp({ mockIpc: true });
    const saved = await page.evaluate(
      (data) =>
        (window as unknown as { stenoai: StenoaiBridge }).stenoai.chat.save(
          data,
        ),
      { sessions: [session] } as ChatSessionsBlob,
    );
    expect(saved.success).toBe(true);
    // The app's shared chat query may already have cached the empty initial
    // response. Reload to exercise loading the saved session through IPC.
    await page.reload();
    await page.evaluate(() => {
      window.location.hash = "#/chat/chart-session";
    });
    const chart = page.getByRole("figure", { name: "Actions by meeting" });
    await expect(chart).toBeVisible();
    await expect(chart.locator(".recharts-surface")).toBeVisible();
    await chart.getByText("View data", { exact: true }).click();
    await expect(
      chart.getByRole("cell", { name: "Planning", exact: true }),
    ).toBeVisible();
    await expect(
      chart.getByRole("cell", {
        name: type === "line" ? "1000000000000" : "5",
        exact: true,
      }),
    ).toBeVisible();
    if (type === "line") {
      const compact = await page.evaluate(() => new Intl.NumberFormat(undefined, { notation: 'compact', maximumSignificantDigits: 3 }).format(1e12));
      await expect(chart.locator(".recharts-surface")).toContainText(compact);
    }
    await expect(page.locator('pre[data-lang="steno-chart"]')).toContainText(
      "unsupported",
    );
    await page.screenshot({ path: testInfo.outputPath(`${type}-chart.png`) });
    await page.reload();
    await expect(
      page.getByRole("figure", { name: "Actions by meeting" }),
    ).toBeVisible();
  });
}

test("a live chat reply renders a stacked multi-series bar and a pie with legends", async ({
  launchApp,
}, testInfo) => {
  const stacked = {
    type: "bar",
    title: "Tickets by day",
    xLabel: "Day",
    yLabel: "Tickets",
    stacked: true,
    series: [
      { name: "Open", data: [{ label: "Mon", value: 3 }, { label: "Tue", value: 1 }] },
      { name: "Closed", data: [{ label: "Mon", value: 2 }, { label: "Tue", value: 4 }] },
    ],
  };
  const pie = {
    type: "pie",
    title: "Time by topic",
    data: [
      { label: "Hiring", value: 20 },
      { label: "Budget", value: 15 },
      { label: "Roadmap", value: 25 },
    ],
  };
  const reply =
    "From the planning notes.\n\n```steno-chart\n" +
    JSON.stringify(stacked) +
    "\n```\n\nAnd the agenda split.\n\n```steno-chart\n" +
    JSON.stringify(pie) +
    "\n```";
  const { app, page } = await launchApp({
    mockIpc: true,
    env: { STENOAI_E2E_CHAT_REPLY: reply },
  });
  await page.evaluate(() => {
    window.location.hash = "#/chat";
  });
  const input = page.getByRole("textbox", { name: "Ask about your notes" });
  await input.fill("Chart my tickets and agenda");
  await input.press("Enter");

  const bar = page.getByRole("figure", { name: "Tickets by day" });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-chart-type", "bar");
  await expect(bar.locator(".recharts-surface").first()).toBeVisible();
  await expect(bar.locator(".recharts-legend-item")).toHaveText(["Open", "Closed"]);
  // Stacked: both series' segments render, four for two days.
  await expect(bar.locator(".recharts-bar-rectangle")).toHaveCount(4);

  const pieChart = page.getByRole("figure", { name: "Time by topic" });
  await expect(pieChart).toBeVisible();
  await expect(pieChart.locator(".recharts-pie-sector")).toHaveCount(3);
  await expect(pieChart.locator(".recharts-legend-item")).toHaveText([
    "Hiring",
    "Budget",
    "Roadmap",
  ]);
  await expect(pieChart.getByRole("button", { name: "Copy data" })).toBeVisible();
  await expect(pieChart.getByRole("button", { name: "Copy as image" })).toBeVisible();

  await bar.getByText("View data", { exact: true }).click();
  await expect(bar.getByRole("columnheader", { name: "Closed" })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("multi-series-charts.png") });
  await pieChart.screenshot({ path: testInfo.outputPath("pie-chart.png") });

  // Copy data writes CSV; Copy as image rasterises the SVG locally to a PNG.
  await pieChart.getByRole("button", { name: "Copy data" }).click();
  await expect(pieChart.getByRole("status")).toHaveText("Copied");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    "label,value\nHiring,20\nBudget,15\nRoadmap,25",
  );
  await bar.getByRole("button", { name: "Copy as image" }).click();
  await expect(bar.getByRole("status")).toHaveText("Copied");
  const image = await app.evaluate(({ clipboard }) => {
    const copied = clipboard.readImage();
    return { size: copied.getSize(), png: copied.toPNG().toString("base64") };
  });
  expect(image.size.width).toBeGreaterThan(300);
  expect(image.size.height).toBeGreaterThan(200);
  writeFileSync(testInfo.outputPath("copied-chart.png"), Buffer.from(image.png, "base64"));
});
