/**
 * Locale for formatted dates and times in the interface.
 *
 * The app ships English-only (see CLAUDE.md, "Interface copy and i18n"), but
 * `toLocaleDateString(undefined, …)` follows the HOST's locale, not the app's.
 * On a German desktop that rendered "Donnerstag, 3. September" as the heading of
 * an otherwise entirely English screen, and "Do., 3. Sept. 2026" in note rows —
 * a half-translated interface nobody chose. CLAUDE.md names date formatting as
 * one of the things the i18n gate deliberately does not catch; this is that gap.
 *
 * WHAT IS PINNED: anything that renders WORDS — weekday and month names. Those
 * are language, and the language of this interface is English.
 *
 * WHAT IS NOT PINNED, on purpose: the 12- versus 24-hour clock. That is a
 * regional habit rather than a language, a German user wants 19:58 beside
 * English month names, and UpcomingCard's TIME_FMT already documents that
 * intent ("US users get 11:30 PM and EU users get 23:30 without a setting").
 * Pure-numeric time formatters therefore keep `undefined`, and the one formatter
 * that mixes weekday names with a clock takes UI_LOCALE plus SYSTEM_HOUR12 so it
 * gets English words and the host's clock convention.
 *
 * When the i18n foundation lands, UI_LOCALE becomes the active language and this
 * is the single place that has to change.
 */
export const UI_LOCALE = 'en';

/**
 * Whether the host formats times as 12-hour. Resolved once at module load,
 * matching hero.ts's reasoning that a locale change means an app relaunch
 * anyway and building an Intl formatter per render is not free.
 *
 * `undefined` when the runtime does not report it — passing that through to
 * Intl means "use the locale's default", which is the right fallback.
 */
export const SYSTEM_HOUR12: boolean | undefined = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
}).resolvedOptions().hour12;
