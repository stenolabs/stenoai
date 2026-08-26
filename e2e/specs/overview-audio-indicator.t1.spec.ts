import { test, expect } from '../fixtures/electron';

/**
 * T1 — renderer-only, mock IPC. The overview's "original audio still exists"
 * indicator.
 *
 * Why it earns a UI spec on top of the backend's own tests: the value of the
 * icon is entirely in it being ABSENT for notes whose recording is gone.
 * keep_recordings defaults off, so most rows have no audio — an icon that
 * rendered unconditionally would look correct on a screenshot and tell the
 * user nothing. Only a pair of rows differing solely in `has_audio` can show
 * the difference.
 */

test('only a note whose recording still exists shows the audio indicator', async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    mockIpc: true,
    env: {
      STENOAI_E2E_SEED_AUDIO_MEETINGS: '1',
      // Without an installed model App.tsx's first-run gate redirects a
      // neutral route to /setup before Home ever renders (same seam the
      // pill-dock T1 uses).
      STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
    },
  });

  const rows = page.getByTestId('previous-row');
  await expect(rows).toHaveCount(2);

  const withAudio = rows.filter({ hasText: 'With audio' });
  const withoutAudio = rows.filter({ hasText: 'Without audio' });

  await expect(withAudio.getByTestId('previous-row-has-audio')).toHaveCount(1);
  await expect(withoutAudio.getByTestId('previous-row-has-audio')).toHaveCount(0);

  // The duration still renders on both -- the icon sits BESIDE it rather
  // than replacing it.
  await expect(withAudio).toContainText('10m');
  await expect(withoutAudio).toContainText('15m');

  // Named for screen readers, not a bare decorative glyph.
  await expect(
    withAudio.getByLabel('Original audio still available'),
  ).toBeVisible();
});
