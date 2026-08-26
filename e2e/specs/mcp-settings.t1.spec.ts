import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC.
 * Proves the Local MCP server settings in the Integrations tab:
 * 1. The MCP section renders and the server toggle is OFF by default.
 * 2. Plain disclosure copy explains local-only (127.0.0.1), key required, and permissions (notes, transcripts, folders, questions).
 * 3. The API key is masked by default until explicitly revealed.
 * 4. Inline port validation rejects values outside 1024-65535 and non-integers without triggering backend mutation.
 * 5. Regenerate key opens a confirmation dialog warning about disconnecting active clients.
 * 6. Client configuration snippet renders with endpoint and Authorization header.
 * 7. Custom key paste input mode toggles and allows cancel.
 *
 * The mcp channels are stubbed statefully in app/e2e-mock-ipc.js (enabling with
 * no key mints one, like the real handler), so this suite also asserts the
 * EFFECT of the toggle. What still belongs to T2 and cannot be proven here:
 * a real localhost socket, a port collision refusal, safeStorage encryption of
 * the key, and the HTTP auth/Origin gates — all covered by
 * e2e/specs/mcp-server.t2.spec.ts against the real endpoint.
 */

test('Local MCP settings render OFF by default with disclosure copy and masked key', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true });

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=integrations';
  });

  const section = page.locator('[data-settings-tab="integrations"]');
  await expect(section).toBeVisible();

  // 1. Off by default
  const toggle = section.getByTestId('mcp-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // 2. Plain disclosure copy (visible above the toggle)
  await expect(section.getByText('Local MCP server', { exact: true })).toBeVisible();
  await expect(
    section.getByText(/Listens on localhost \(127\.0\.0\.1\) only/),
  ).toBeVisible();
  await expect(
    section.getByText(/requires an API key on every request/),
  ).toBeVisible();
  await expect(
    section.getByText(/read your notes, transcripts, and folders/),
  ).toBeVisible();
  await expect(
    section.getByText(/ask questions across them/),
  ).toBeVisible();

  // 3. Key is masked by default
  const maskedKey = section.getByTestId('mcp-key-masked');
  await expect(maskedKey).toBeVisible();
  await expect(maskedKey).toHaveText('••••••••••••••••••••••••••••••••');
  await expect(section.getByTestId('mcp-key-revealed')).toHaveCount(0);

  // Reveal button is available
  await expect(section.getByTestId('mcp-reveal-key-btn')).toHaveText('Reveal');
});

test('MCP port validation rejects invalid ports inline', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=integrations';
  });

  const section = page.locator('[data-settings-tab="integrations"]');
  await expect(section).toBeVisible();

  const portInput = section.getByTestId('mcp-port-input');
  await expect(portInput).toBeVisible();
  await expect(portInput).toHaveValue('27127');

  // No error initially
  await expect(section.getByTestId('mcp-port-error')).toHaveCount(0);

  // Type invalid port < 1024
  await portInput.fill('80');
  const errorMsg = section.getByTestId('mcp-port-error');
  await expect(errorMsg).toBeVisible();
  await expect(errorMsg).toHaveText('Port must be an integer between 1024 and 65535.');

  // Type invalid port > 65535
  await portInput.fill('70000');
  await expect(errorMsg).toBeVisible();
  await expect(errorMsg).toHaveText('Port must be an integer between 1024 and 65535.');

  // Type non-numeric
  await portInput.fill('abc');
  await expect(errorMsg).toBeVisible();
  await expect(errorMsg).toHaveText('Port must be an integer between 1024 and 65535.');

  // Type valid port
  await portInput.fill('27128');
  await expect(section.getByTestId('mcp-port-error')).toHaveCount(0);
});

test('MCP client configuration snippet displays endpoint and Authorization header', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true });

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=integrations';
  });

  const section = page.locator('[data-settings-tab="integrations"]');
  await expect(section).toBeVisible();

  const configBlock = section.getByTestId('mcp-client-config');
  await expect(configBlock).toBeVisible();
  await expect(configBlock).toContainText('http://127.0.0.1:27127/mcp');
  await expect(configBlock).toContainText('"Authorization": "Bearer YOUR_API_KEY"');
  await expect(section.getByTestId('mcp-copy-config-btn')).toBeVisible();
});

test('Regenerate API key triggers confirmation dialog', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=integrations';
  });

  const section = page.locator('[data-settings-tab="integrations"]');
  await expect(section).toBeVisible();

  const regenBtn = section.getByTestId('mcp-regenerate-key-btn');
  await expect(regenBtn).toBeVisible();
  await regenBtn.click();

  // Confirmation dialog opens
  const dialog = page.locator('[data-confirm-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Regenerate MCP API key?');
  await expect(dialog).toContainText('disconnect any active MCP clients');

  // Cancel closes dialog
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('Paste custom key toggles input mode and allows cancel', async ({ launchApp }) => {
  const { page } = await launchApp({ mockIpc: true });

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=integrations';
  });

  const section = page.locator('[data-settings-tab="integrations"]');
  await expect(section).toBeVisible();

  const customKeyBtn = section.getByTestId('mcp-custom-key-btn');
  await expect(customKeyBtn).toBeVisible();
  await customKeyBtn.click();

  const customKeyInput = section.getByTestId('mcp-custom-key-input');
  await expect(customKeyInput).toBeVisible();
  await expect(section.getByTestId('mcp-save-custom-key-btn')).toBeVisible();
  const cancelBtn = section.getByTestId('mcp-cancel-custom-key-btn');
  await expect(cancelBtn).toBeVisible();

  // Cancel reverts to masked display
  await cancelBtn.click();
  await expect(section.getByTestId('mcp-custom-key-input')).toHaveCount(0);
  await expect(section.getByTestId('mcp-key-masked')).toBeVisible();
});

test('enabling the server reports it running, unlocks copy, and stops on disable', async ({
  launchApp,
}) => {
  const { page } = await launchApp({ mockIpc: true });

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=integrations';
  });

  const section = page.locator('[data-settings-tab="integrations"]');
  await expect(section).toBeVisible();

  // Stopped: the URL is shown (it says which port will be used) but copying it
  // is refused - a one-click copy of a dead endpoint just sends the user off to
  // configure a client that cannot connect.
  const endpoint = section.getByTestId('mcp-endpoint-url');
  await expect(endpoint).toBeVisible();
  await expect(endpoint).toContainText('http://127.0.0.1:');
  await expect(endpoint).toContainText('/mcp');
  const copyBtn = section.getByTestId('mcp-copy-endpoint-btn');
  await expect(copyBtn).toBeDisabled();
  await expect(section.getByText(/Server is stopped/)).toBeVisible();

  const toggle = section.getByTestId('mcp-toggle');
  await expect(toggle).not.toBeChecked();
  await toggle.click();

  // Enabling with no key mints one and brings the server up: the status line
  // flips and copy becomes available.
  await expect(toggle).toBeChecked();
  await expect(section.getByText(/The server is running locally/)).toBeVisible();
  await expect(copyBtn).toBeEnabled();

  // The key now exists, and revealing shows a real value rather than the mask.
  await section.getByTestId('mcp-reveal-key-btn').click();
  const revealed = section.getByTestId('mcp-key-revealed');
  await expect(revealed).toBeVisible();
  await expect(revealed).not.toHaveText('');
  await expect(revealed).not.toContainText('\u2022\u2022\u2022\u2022');

  // Turning it back off withdraws the copy affordance again.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(section.getByText(/Server is stopped/)).toBeVisible();
  await expect(copyBtn).toBeDisabled();
});
