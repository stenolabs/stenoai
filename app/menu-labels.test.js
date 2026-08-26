const { test } = require('node:test');
const assert = require('node:assert');

const { menuLabels, uiLocaleFromSystem } = require('./menu-labels');

test('uiLocaleFromSystem maps Chinese system locales to zh-TW', () => {
  assert.strictEqual(uiLocaleFromSystem('zh-TW'), 'zh-TW');
  assert.strictEqual(uiLocaleFromSystem('zh-HK'), 'zh-TW');
  assert.strictEqual(uiLocaleFromSystem('zh'), 'zh-TW');
  assert.strictEqual(uiLocaleFromSystem('ZH'), 'zh-TW');
});

test('uiLocaleFromSystem maps any other system locale to en', () => {
  assert.strictEqual(uiLocaleFromSystem('en-US'), 'en');
  assert.strictEqual(uiLocaleFromSystem('fr-FR'), 'en');
  assert.strictEqual(uiLocaleFromSystem(''), 'en');
  assert.strictEqual(uiLocaleFromSystem(undefined), 'en');
});

test('menuLabels returns zh-TW copy for a Chinese system locale', () => {
  assert.deepStrictEqual(menuLabels('zh-TW'), {
    settings: '設定…',
    learnMore: '深入了解',
    reportBug: '回報問題',
    file: '檔案',
  });
});

test('menuLabels returns English copy for a non-Chinese system locale', () => {
  assert.deepStrictEqual(menuLabels('en-US'), {
    settings: 'Settings…',
    learnMore: 'Learn More',
    reportBug: 'Report a Bug',
    file: 'File',
  });
});

test('menuLabels falls back to English for an unrecognized locale', () => {
  assert.deepStrictEqual(menuLabels(''), menuLabels('en-US'));
  assert.deepStrictEqual(menuLabels(undefined), menuLabels('en-US'));
});
