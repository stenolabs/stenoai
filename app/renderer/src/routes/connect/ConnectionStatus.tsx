import { Check } from 'lucide-react';
import { t } from '@/i18n';

/**
 * "Connected" with an optional quiet hint saying how (the Steno skill or an
 * MCP connection). Read-only: it reports what is on disk, it is not a control.
 */
export function ConnectionStatus({ via }: { via?: 'skill' | 'mcp' }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[12.5px]"
      style={{ color: 'var(--fg-2)' }}
    >
      <Check aria-hidden className="size-3.5" />
      {t('connect.connected')}
      {via && (
        <span className="text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
          {via === 'skill' ? t('connect.via.skill') : t('connect.via.mcp')}
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
