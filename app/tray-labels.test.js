const { test } = require('node:test');
const assert = require('node:assert');

const { trayLabels, uiLocaleFromSystem } = require('./tray-labels');

test('uiLocaleFromSystem maps Chinese system locales to zh-TW', () => {
  assert.strictEqual(uiLocaleFromSystem('zh-TW'), 'zh-TW');
  assert.strictEqual(uiLocaleFromSystem('zh-HK'), 'zh-TW');
  assert.strictEqual(uiLocaleFromSystem('zh'), 'zh-TW');
  assert.strictEqual(uiLocaleFromSystem('ZH'), 'zh-TW');
});

test('uiLocaleFromSystem maps any other system locale to en', () => {
  assert.strictEqual(uiLocaleFromSystem('en-US'), 'en');
  assert.strictEqual(uiLocaleFromSystem('en-GB'), 'en');
  assert.strictEqual(uiLocaleFromSystem('fr-FR'), 'en');
  assert.strictEqual(uiLocaleFromSystem(''), 'en');
  assert.strictEqual(uiLocaleFromSystem(undefined), 'en');
});

test('trayLabels returns zh-TW copy for a Chinese system locale', () => {
  assert.deepStrictEqual(trayLabels('zh-TW'), {
    open: '開啟 Steno',
    stop: '停止錄音',
    start: '開始錄音',
    settings: '設定',
    hide: '隱藏 Steno',
    reportBug: '回報問題',
    quit: '離開 Steno',
  });
});

test('trayLabels returns English copy for a non-Chinese system locale', () => {
  assert.deepStrictEqual(trayLabels('en-US'), {
    open: 'Open Steno',
    stop: 'Stop Recording',
    start: 'Start Recording',
    settings: 'Settings',
    hide: 'Hide Steno',
    reportBug: 'Report a Bug',
    quit: 'Quit Steno',
  });
});

test('trayLabels falls back to English for an unrecognized locale', () => {
  assert.deepStrictEqual(trayLabels(''), trayLabels('en-US'));
  assert.deepStrictEqual(trayLabels(undefined), trayLabels('en-US'));
});
