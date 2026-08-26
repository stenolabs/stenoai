// Pure application-menu copy for main.js, extracted so it's unit-testable
// without Electron. Follows the same approach as app/tray-labels.js: the
// native menu bar is the one place Electron's role-based items
// (file/edit/view/window/help) auto-localize, but the app's own labels —
// "Settings…", "Learn More", "Report a Bug", and the Windows "&File" accelerator
// entry — are hardcoded and must be translated by hand.
//
// Like the tray menu, this follows the OS system locale (app.getLocale())
// because main.js has no renderer localStorage to read; it matches the
// renderer's explicit preference for any default install.

// Map the OS language to the app's two supported UI locales.
function uiLocaleFromSystem(systemLocale) {
  const language = String(systemLocale || '').split('-')[0].toLowerCase();
  return language === 'zh' ? 'zh-TW' : 'en';
}

const LABELS = {
  'zh-TW': {
    settings: '設定…',
    learnMore: '深入了解',
    reportBug: '回報問題',
    // The leading '&' marks the accelerator key in the menu; keep it for the
    // zh-TW label so the keyboard shortcut still works on Windows.
    file: '檔案',
  },
  en: {
    settings: 'Settings…',
    learnMore: 'Learn More',
    reportBug: 'Report a Bug',
    file: 'File',
  },
};

/**
 * @param {string} systemLocale OS locale from Electron's app.getLocale().
 * @returns {{settings:string, learnMore:string, reportBug:string, file:string}}
 */
function menuLabels(systemLocale) {
  return LABELS[uiLocaleFromSystem(systemLocale)] || LABELS.en;
}

module.exports = { menuLabels, uiLocaleFromSystem };
