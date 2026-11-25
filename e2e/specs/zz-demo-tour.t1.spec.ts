import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures/electron';

/**
 * The README demo: a paced tour of the app, recorded and encoded to
 * website/public/demo.gif (+ readme.png, the static fallback) and an MP4.
 *
 * NOT part of any normal run: every test here skips unless STENOAI_DEMO_TOUR
 * names an output directory. Mock IPC only (no backend, no model, no network);
 * the fictional workspace is seeded by STENOAI_E2E_DEMO=1 in app/e2e-mock-ipc.js.
 *
 *   cd app && npm run build:renderer
 *   STENOAI_DEMO_TOUR=/tmp/steno-demo npm run test:e2e -- --project=t1 zz-demo-tour
 *   cp /tmp/steno-demo/demo.gif /tmp/steno-demo/readme.png ../website/public/
 *
 * Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg). Frames come from the
 * DevTools screencast, which only emits when the picture changes, so each
 * frame carries its own duration and holds cost nothing. The run logs when
 * each section starts; keep the whole tour near 35 s so the GIF stays under
 * ~8 MB at 1200 px / 12 fps (STENOAI_DEMO_GIF_FPS lowers the frame rate).
 */

const OUT = process.env.STENOAI_DEMO_TOUR || '';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const WIDTH = 1280;
const HEIGHT = 800;
const GIF_WIDTH = 1200;
const GIF_FPS = Number(process.env.STENOAI_DEMO_GIF_FPS) || 12;
const HERO_NOTE = 'q1-roadmap-review_summary.md';
// The README ships the dark theme; STENOAI_DEMO_THEME=light records the other.
const THEME: 'dark' | 'light' = process.env.STENOAI_DEMO_THEME === 'light' ? 'light' : 'dark';
// Pointer colours: ink on paper, paper on ink (CLAUDE.md brand colours).
const CURSOR = THEME === 'dark'
  ? { fill: '#EDEAE0', stroke: '#1A1A18', ring: 'rgba(237,234,224,0.28)' }
  : { fill: '#1B1B19', stroke: '#ffffff', ring: 'rgba(27,27,25,0.22)' };

const CHART = {
  type: 'bar',
  title: 'Action items by meeting',
  yLabel: 'Action items',
  data: [
    { label: 'Halden renewal', value: 5 },
    { label: 'Q1 roadmap', value: 4 },
    { label: 'Brightwater', value: 3 },
    { label: 'Design critique', value: 2 },
  ],
};
const CHAT_REPLY =
  'Your open action items, by meeting.\n\n```steno-chart\n' +
  JSON.stringify(CHART) +
  '\n```\n\nThe Halden Freight renewal call has the most follow-ups.';

const ENV = {
  STENOAI_E2E_DEMO: '1',
  STENOAI_E2E_MOCK_PARAKEET_INSTALLED: '1',
  STENOAI_E2E_CHAT_STREAM: '1',
  STENOAI_E2E_CHAT_STREAM_MS: '45',
  STENOAI_E2E_CHAT_REPLY: CHAT_REPLY,
};

test.skip(!OUT, 'README demo tour: set STENOAI_DEMO_TOUR=<output dir> to record it');

type Launch = (opts?: {
  mockIpc?: boolean;
  releaseHighlightsSeen?: boolean;
  env?: Record<string, string>;
}) => Promise<{ app: ElectronApplication; page: Page }>;

/** Fixed window, the chosen theme, tips dismissed, motion on. */
async function launchDemo(launchApp: Launch) {
  const { app, page } = await launchApp({ mockIpc: true, releaseHighlightsSeen: true, env: ENV });
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!);
    },
    [WIDTH, HEIGHT],
  );
  await page.evaluate((theme) => {
    // What Settings > General > Theme persists (hooks/useTheme.ts).
    localStorage.setItem('steno-theme', theme);
    localStorage.setItem('steno-tips-dismissed', JSON.stringify(['chat-slash', 'connect-actions', 'note-edit']));
  }, THEME);
  await page.emulateMedia({ colorScheme: THEME, reducedMotion: 'no-preference' });
  await page.reload();
  await page.waitForSelector('[data-app-ready]');
  await expect(page.locator('html')).toHaveAttribute('data-theme', THEME);
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await expect(page.getByText('Q1 roadmap review').first()).toBeVisible();
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([WIDTH, HEIGHT]);
  return { app, page };
}

/** A pointer drawn in the page, since a screencast has no OS cursor. */
async function installCursor(page: Page, x: number, y: number) {
  await page.evaluate(
    ([startX, startY, fill, stroke, ring]) => {
      const cursor = document.createElement('div');
      cursor.id = 'demo-cursor';
      Object.assign(cursor.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '26px',
        height: '26px',
        pointerEvents: 'none',
        zIndex: '2147483647',
        filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.35))',
        transform: `translate(${Number(startX) - 5}px, ${Number(startY) - 3}px)`,
      });
      cursor.innerHTML =
        `<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 3l13.5 8.6-5.9 1.2 3.6 6.8-2.6 1.4-3.6-6.8L5.6 18.6z" fill="${fill}" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
      document.documentElement.appendChild(cursor);
      window.addEventListener(
        'mousemove',
        (e) => {
          cursor.style.transform = `translate(${e.clientX - 5}px, ${e.clientY - 3}px)`;
        },
        true,
      );
      window.addEventListener(
        'mousedown',
        (e) => {
          const ring = document.createElement('div');
          Object.assign(ring.style, {
            position: 'fixed',
            left: `${e.clientX - 16}px`,
            top: `${e.clientY - 16}px`,
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: String(ring),
            pointerEvents: 'none',
            zIndex: '2147483646',
          });
          document.documentElement.appendChild(ring);
          ring
            .animate(
              [
                { transform: 'scale(0.3)', opacity: 1 },
                { transform: 'scale(1.5)', opacity: 0 },
              ],
              { duration: 480, easing: 'ease-out' },
            )
            .finished.then(() => ring.remove());
        },
        true,
      );
    },
    [x, y, CURSOR.fill, CURSOR.stroke, CURSOR.ring] as const,
  );
}

/** The tour's hands: an eased pointer, paced typing, eased wheel scrolling. */
function director(page: Page) {
  let pos = { x: WIDTH / 2, y: HEIGHT / 2 };
  const pause = (ms: number) => page.waitForTimeout(ms);
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

  async function glide(x: number, y: number, ms?: number) {
    const from = pos;
    const distance = Math.hypot(x - from.x, y - from.y);
    const duration = ms ?? Math.min(700, 220 + distance * 0.55);
    const steps = Math.max(8, Math.round(duration / 16));
    const started = Date.now();
    for (let i = 1; i <= steps; i += 1) {
      const k = ease(i / steps);
      await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      const due = started + (duration * i) / steps;
      const wait = due - Date.now();
      if (wait > 0) await pause(wait);
    }
    pos = { x, y };
  }

  async function pointAt(target: Locator, at?: { fx?: number; fy?: number }) {
    const box = await target.boundingBox();
    if (!box) throw new Error('demo tour: target is not on screen');
    await glide(box.x + box.width * (at?.fx ?? 0.5), box.y + box.height * (at?.fy ?? 0.5));
  }

  async function click(target: Locator, at?: { fx?: number; fy?: number }) {
    await pointAt(target, at);
    await pause(110);
    await page.mouse.down();
    await pause(70);
    await page.mouse.up();
  }

  async function scroll(dy: number, ms = 900) {
    const started = Date.now();
    let done = 0;
    while (done !== dy) {
      const k = Math.min(1, (Date.now() - started) / ms);
      const target = Math.round(dy * ease(k));
      if (target !== done) await page.mouse.wheel(0, target - done);
      done = target;
      if (k >= 1) break;
      await pause(12);
    }
  }

  const type = (text: string, delay = 55) => page.keyboard.type(text, { delay });

  return { pause, glide, pointAt, click, scroll, type, start: pos };
}

test('README demo tour', async ({ launchApp }) => {
  test.setTimeout(240_000);
  const framesDir = path.join(OUT, 'frames');
  mkdirSync(framesDir, { recursive: true });

  const { app, page } = await launchDemo(launchApp);
  const d = director(page);
  await installCursor(page, d.start.x, d.start.y);
  await page.mouse.move(d.start.x, d.start.y);

  // Record: one JPEG per changed picture, stamped with its own wall-clock time.
  const cdp = await page.context().newCDPSession(page);
  const frames: { file: string; at: number }[] = [];
  cdp.on('Page.screencastFrame', (frame) => {
    const file = `f${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(path.join(framesDir, file), Buffer.from(frame.data, 'base64'));
    frames.push({ file, at: frame.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: WIDTH * 2,
    maxHeight: HEIGHT * 2,
    everyNthFrame: 1,
  });

  const t0 = Date.now();
  const mark = (label: string) => console.log(`demo tour: ${((Date.now() - t0) / 1000).toFixed(1)}s ${label}`);

  // 1. Home: a few notes, the sidebar.
  await d.pause(1700);

  mark('note');
  // 2. Open a note; click into a key point and edit it. Autosave says "Saved".
  await d.click(page.getByText('Q1 roadmap review').first());
  await expect(page.getByTestId('meeting-detail')).toBeVisible();
  await d.pause(1400);
  const keyPoint = page.getByRole('textbox', { name: 'Key point 2', exact: true });
  await d.click(keyPoint, { fx: 0.9 });
  // The End key scrolls on macOS; put the caret at the end directly.
  await keyPoint.evaluate((el) => {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.setSelectionRange(el.value.length, el.value.length);
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  });
  await d.pause(250);
  await d.type(' Android first.', 48);
  await expect(page.getByTestId('note-save-status')).toHaveText('Saved');
  await d.pause(900);

  mark('actions');
  // 3. Suggested actions: approve the Linear issue; it settles to one line.
  const actions = page.getByTestId('suggested-actions');
  const linear = actions.getByRole('article', { name: /via Linear/ });
  const approve = linear.getByRole('button', { name: 'Approve' });
  const approveBox = await approve.boundingBox();
  await d.scroll(Math.max(0, (approveBox?.y ?? HEIGHT) - HEIGHT * 0.62), 900);
  await d.pause(900);
  await d.click(approve);
  await expect(linear.getByText('Done')).toBeVisible();
  await d.pause(1100);

  mark('chat');
  // 4. Chat: the dragonfly, "/" recipes filtered by typing, then a charted answer.
  await d.click(page.getByRole('button', { name: 'Chat', exact: true }).first());
  const input = page.getByRole('textbox', { name: 'Ask about your notes' });
  await expect(input).toBeVisible();
  await d.pause(1000);
  await d.click(input);
  await d.pause(200);
  await d.type('/', 0);
  await expect(page.getByRole('menu', { name: 'Recipes' })).toBeVisible();
  await d.pause(700);
  await d.type('week', 110);
  await expect(page.getByRole('menu', { name: 'Recipes' }).getByRole('menuitem')).toHaveCount(1);
  await d.pause(900);
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Backspace');
    await d.pause(40);
  }
  await d.pause(150);
  await d.type('Chart action items by meeting', 36);
  await d.pause(300);
  await page.keyboard.press('Enter');
  await d.glide(WIDTH * 0.9, HEIGHT * 0.55, 500);
  await expect(page.getByRole('figure', { name: CHART.title })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('most', { exact: false }).last()).toBeVisible({ timeout: 15_000 });
  await app.evaluate(() => (globalThis as unknown as { __finishChat: () => void }).__finishChat());
  await d.pause(2000);

  mark('connect');
  // 5. Connect: coding agents, AI apps, actions - one slow pass down the page.
  await d.click(page.getByRole('button', { name: /^Connect/ }).first());
  await expect(page.getByRole('heading', { name: 'Connect', exact: true })).toBeVisible();
  await d.glide(WIDTH * 0.63, HEIGHT * 0.6, 400);
  await d.pause(700);
  const headingBox = await page.getByRole('heading', { name: 'Actions', exact: true }).boundingBox();
  await d.scroll(Math.max(0, (headingBox?.y ?? 500) - 110), 2000);
  await d.pause(1200);

  mark('cookbooks');
  // 6. Cookbooks: covers, the Recipes tab, and back up to the intro carousel.
  await d.click(page.getByRole('button', { name: /^Cookbooks/ }).first());
  await expect(page.getByRole('heading', { level: 1, name: 'Cookbooks' })).toBeVisible();
  await d.pause(1000);
  await d.glide(WIDTH * 0.6, HEIGHT * 0.7, 300);
  await d.scroll(400, 800);
  await d.pause(1000);
  await d.click(page.getByRole('tab', { name: 'Recipes' }));
  await d.pause(1200);
  await d.scroll(-1200, 600);
  await d.click(page.getByRole('button', { name: 'Show “What\'s a recipe?”' }));
  await expect(page.getByRole('region', { name: "What's a recipe?" })).toBeVisible();
  await d.glide(WIDTH * 0.52, HEIGHT * 0.62, 400);
  await d.pause(1300);

  mark('end');
  await cdp.send('Page.stopScreencast');
  const endedAt = Date.now() / 1000;
  await d.pause(200);

  // Encode. Each frame holds until the next one; the last holds until the end.
  expect(frames.length).toBeGreaterThan(100);
  const list = ['ffconcat version 1.0'];
  frames.forEach((frame, i) => {
    const next = i + 1 < frames.length ? frames[i + 1]!.at : endedAt;
    list.push(`file 'frames/${frame.file}'`, `duration ${Math.max(0.001, next - frame.at).toFixed(4)}`);
  });
  list.push(`file 'frames/${frames[frames.length - 1]!.file}'`);
  const concat = path.join(OUT, 'frames.ffconcat');
  writeFileSync(concat, list.join('\n') + '\n');
  const ffmpeg = (args: string[]) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  const input0 = ['-f', 'concat', '-safe', '0', '-i', concat];
  const length = ['-t', (endedAt - frames[0]!.at).toFixed(2)];
  ffmpeg([
    ...input0,
    '-vf', 'fps=30,scale=1920:-2:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', ...length,
    path.join(OUT, 'steno-demo.mp4'),
  ]);
  ffmpeg([
    ...input0,
    '-vf',
    `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];` +
      '[a]palettegen=max_colors=192:stats_mode=full[p];' +
      '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    ...length, '-loop', '0',
    path.join(OUT, 'demo.gif'),
  ]);
  console.log(`demo tour: ${frames.length} frames over ${(endedAt - frames[0]!.at).toFixed(1)}s -> ${OUT}`);
});

test('README hero still', async ({ launchApp }) => {
  const { page } = await launchDemo(launchApp);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'hero-home@2x.png') });
  await page.evaluate((file) => {
    window.location.hash = `#/meetings/${encodeURIComponent(file)}`;
  }, HERO_NOTE);
  await expect(page.getByTestId('meeting-detail')).toBeVisible();
  await expect(page.getByTestId('suggested-actions')).toBeVisible();
  await page.waitForTimeout(800);
  const still = path.join(OUT, 'hero-note@2x.png');
  await page.screenshot({ path: still });
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error', '-i', still,
    '-vf', 'scale=1600:-1:flags=lanczos', '-frames:v', '1', '-update', '1',
    path.join(OUT, 'readme.png'),
  ]);
});
