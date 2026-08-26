// Pure tray-menu copy for main.js, extracted so it's unit-testable without
// Electron. Keeps the custom tray menu (Electron's role-based application
// menus already auto-localize by system locale) consistent with the renderer's
// zh-TW localization: when the system language is Chinese, the tray menu renders
// 繁體中文, otherwise English.
//
// The renderer defaults to English and stores the user's explicit UI-locale
// preference in localStorage, while the native menu has no renderer to read,
// so the tray menu follows the *system* locale instead — matching Electron's
// built-in menu behavior.

// Map the OS language (app.getLocale() returns e.g. 'zh-TW', 'en-US', 'zh-HK')
// to the app's two supported UI locales. Anything not recognizably Chinese is
// treated as English, matching the renderer's default fallback.
function uiLocaleFromSystem(systemLocale) {
  const language = String(systemLocale || '').split('-')[0].toLowerCase();
  return language === 'zh' ? 'zh-TW' : 'en';
}

const LABELS = {
  'zh-TW': {
    open: '開啟 Steno',
    stop: '停止錄音',
    start: '開始錄音',
    settings: '設定',
    hide: '隱藏 Steno',
    reportBug: '回報問題',
    quit: '離開 Steno',
  },
  en: {
    open: 'Open Steno',
    stop: 'Stop Recording',
    start: 'Start Recording',
    settings: 'Settings',
    hide: 'Hide Steno',
    reportBug: 'Report a Bug',
    quit: 'Quit Steno',
  },
};

/**
 * @param {string} systemLocale OS locale from Electron's app.getLocale().
 * @returns {{open:string, stop:string, start:string, settings:string,
 *    hide:string, reportBug:string, quit:string}}
 */
function trayLabels(systemLocale) {
  return LABELS[uiLocaleFromSystem(systemLocale)] || LABELS.en;
}

module.exports = { trayLabels, uiLocaleFromSystem };
