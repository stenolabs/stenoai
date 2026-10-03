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
