import { Check } from 'lucide-react';
import { t } from '@/i18n';

/** "Last used 5 min ago" for an ISO time, or null when there is none. */
export function lastUsedLabel(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t('connect.lastUsed.justNow');
  if (minutes < 60) return t('connect.lastUsed.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('connect.lastUsed.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t('connect.lastUsed.yesterday');
  return t('connect.lastUsed.days', { count: days });
}

/**
 * What is on disk for one assistant, read-only (it is not a control):
 * "Connected" when Steno is configured as its MCP server, otherwise "Skill
 * installed" when only the Steno skill is. A connected card can add a quiet
 * "Skill installed" hint and when the connection was last used.
 */
export function ConnectionStatus({
  mcp,
  skill = false,
  lastUsed,
}: {
  mcp: boolean;
  skill?: boolean;
  lastUsed?: string | null;
}) {
  const used = mcp ? lastUsedLabel(lastUsed) : null;
  if (!mcp && !skill) return null;
  return (
    <span
      className="inline-flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px]"
      style={{ color: 'var(--fg-2)' }}
    >
      <span className="inline-flex items-center gap-1">
        <Check aria-hidden className="size-3.5" />
        {mcp ? t('connect.connected') : t('connect.skillInstalled')}
      </span>
      {mcp && skill && (
        <span className="text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
          {t('connect.skillInstalled')}
        </span>
      )}
      {used && (
        <span className="text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
          {used}
        </span>
      )}
    </span>
  );
}

export function ComingSoonBadge() {
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[11.5px]"
      style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
    >
      {t('connect.comingSoon')}
    </span>
  );
}

/** The heading + one-line intro every Connect section opens with. */
export function SectionHeading({ id, title, intro }: { id: string; title: string; intro: string }) {
  return (
    <>
      <h2 id={id} className="text-[15px] font-medium">
        {title}
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
        {intro}
      </p>
    </>
  );
}
