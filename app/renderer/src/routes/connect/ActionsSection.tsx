import { t } from '@/i18n';
import { ConnectGlyph } from './ConnectGlyph';

/**
 * Suggested actions via MCP endpoints (Part 2 of the Steno MCP spec). Not
 * functional yet: the cards only announce what is coming. Part 2 replaces the
 * "Coming soon" state with endpoint setup and approval cards.
 */
export function ActionsSection() {
  const tools = [
    { id: 'n8n', name: t('connect.actions.n8n.name'), initials: t('connect.actions.n8n.initials') },
    {
      id: 'zapier',
      name: t('connect.actions.zapier.name'),
      initials: t('connect.actions.zapier.initials'),
    },
    {
      id: 'make',
      name: t('connect.actions.make.name'),
      initials: t('connect.actions.make.initials'),
    },
  ];
  return (
    <section aria-labelledby="connect-actions-heading" className="mt-10">
      <h2 id="connect-actions-heading" className="text-sm font-medium">
        {t('connect.actions.heading')}
      </h2>
      <p
        className="mt-1 max-w-[560px] text-[13px] leading-relaxed"
        style={{ color: 'var(--fg-2)' }}
      >
        {t('connect.actions.intro')}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {tools.map((tool) => (
          <section
            key={tool.id}
            aria-label={tool.name}
            className="flex items-center gap-3 rounded-xl border p-4"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
          >
            <ConnectGlyph kind="initials" initials={tool.initials} />
            <div className="min-w-0 flex-1">
              <h3 className="text-[14px] font-medium">{tool.name}</h3>
              <p className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
                {t('connect.comingSoon')}
              </p>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
