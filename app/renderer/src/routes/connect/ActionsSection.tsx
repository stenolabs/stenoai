import * as React from 'react';
import { Check, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useActionsOverview, useConnectConnector, useSetAutoSuggest } from '@/hooks/useActions';
import { actionErrorMessage } from '@/lib/actionErrors';
import { ipc, type ActionConnector, type ActionConnectorId } from '@/lib/ipc';
import { SettingRow } from '@/routes/settings/primitives';
import { t } from '@/i18n';
import { ActionConnectionCard } from './ActionConnectionCard';
import { AddEndpointDialog } from './AddEndpointDialog';
import { BrandGlyph, ConnectGlyph } from './ConnectGlyph';
import type { BrandSlug, MulticolorBrandSlug } from './brandLogos';
import { RecentActions } from './RecentActions';

function connectorCopy(id: ActionConnectorId): {
  name: string;
  description: string;
  initials: string;
} {
  switch (id) {
    case 'linear':
      return {
        name: t('connect.actions.linear.name'),
        description: t('connect.actions.linear.description'),
        initials: t('connect.actions.linear.initials'),
      };
    case 'notion':
      return {
        name: t('connect.actions.notion.name'),
        description: t('connect.actions.notion.description'),
        initials: t('connect.actions.notion.initials'),
      };
    case 'atlassian':
      return {
        name: t('connect.actions.atlassian.name'),
        description: t('connect.actions.atlassian.description'),
        initials: t('connect.actions.atlassian.initials'),
      };
    case 'hubspot':
      return {
        name: t('connect.actions.hubspot.name'),
        description: t('connect.actions.hubspot.description'),
        initials: t('connect.actions.hubspot.initials'),
      };
    case 'slack':
      return {
        name: t('connect.actions.slack.name'),
        description: t('connect.actions.slack.description'),
        initials: t('connect.actions.slack.initials'),
      };
    default:
      return {
        name: t('connect.actions.asana.name'),
        description: t('connect.actions.asana.description'),
        initials: t('connect.actions.asana.initials'),
      };
  }
}

/** Brand mark per connector. */
const CONNECTOR_BRAND: Partial<Record<ActionConnectorId, BrandSlug | MulticolorBrandSlug>> = {
  linear: 'linear',
  slack: 'slack',
  notion: 'notion',
  atlassian: 'jira',
  hubspot: 'hubspot',
  asana: 'asana',
};

const CUSTOM_BRANDS: BrandSlug[] = ['n8n', 'zapier', 'make'];

/**
 * Turn meetings into actions: connect MCP endpoints (vendor servers over
 * OAuth, or any custom endpoint such as n8n, Zapier or Make), then approve
 * the actions Steno suggests under each note. Backed by app/mcp-actions.js.
 */
export function ActionsSection() {
  const overview = useActionsOverview();
  const connect = useConnectConnector();
  const setAutoSuggest = useSetAutoSuggest();
  const [addOpen, setAddOpen] = React.useState(false);
  const [addKey, setAddKey] = React.useState(0);
  const [pendingConnector, setPendingConnector] = React.useState<ActionConnectorId | null>(null);
  const [connectError, setConnectError] = React.useState('');

  const data = overview.data;
  const policy = data?.policy;
  const disabled = policy ? !policy.actionsEnabled : false;
  const connections = data?.connections ?? [];
  const connectors = data?.connectors ?? [];

  const startConnector = (c: ActionConnector) => {
    setConnectError('');
    setPendingConnector(c.id);
    connect.mutate([c.id], {
      onError: (e) => setConnectError(actionErrorMessage(e)),
      onSettled: () => setPendingConnector(null),
    });
  };

  return (
    <section aria-labelledby="connect-actions-heading" className="mt-10">
      <h2 id="connect-actions-heading" className="text-[15px] font-medium">
        {t('connect.actions.heading')}
      </h2>
      <p
        className="mt-1 max-w-[560px] text-[13px] leading-relaxed"
        style={{ color: 'var(--fg-2)' }}
      >
        {t('connect.actions.intro')}
      </p>

      {disabled && (
        <p
          role="status"
          className="mt-4 rounded-lg p-3 text-[13px]"
          style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
        >
          {policy?.reason === 'policy-unavailable'
            ? t('connect.actions.policyUnavailable')
            : t('connect.actions.disabledByOrg')}
        </p>
      )}
      {!disabled && policy?.managed && policy.endpointAllowlist && (
        <p className="mt-3 text-[12.5px]" style={{ color: 'var(--fg-muted)' }}>
          {t('connect.actions.allowlistNote')}
        </p>
      )}
      {data && !data.secureStorage && (
        <p role="alert" className="mt-3 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          {t('connect.actions.noSecureStorage')}
        </p>
      )}

      {!disabled && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {connectors.map((c) => {
            const copy = connectorCopy(c.id);
            const connected = connections.some((x) => x.kind === c.id && x.status === 'ok');
            const comingSoon = c.status !== 'available';
            const pending = pendingConnector === c.id;
            return (
              <section
                key={c.id}
                aria-label={copy.name}
                className="flex min-w-0 items-start gap-3 rounded-xl border p-4"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
              >
                {CONNECTOR_BRAND[c.id] ? (
                  <BrandGlyph brand={CONNECTOR_BRAND[c.id] as BrandSlug | MulticolorBrandSlug} />
                ) : (
                  <ConnectGlyph kind="initials" initials={copy.initials} />
                )}
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] font-medium">{copy.name}</h3>
                  <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
                    {copy.description}
                  </p>
                </div>
                {comingSoon ? (
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[11.5px]"
                    style={{ background: 'var(--surface-sunken)', color: 'var(--fg-2)' }}
                  >
                    {t('connect.comingSoon')}
                  </span>
                ) : connected ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-[12.5px]"
                    style={{ color: 'var(--fg-2)' }}
                  >
                    <Check aria-hidden className="size-3.5" />
                    {t('connect.connected')}
                  </span>
                ) : pending ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-[30px] shrink-0 px-3 text-[13px]"
                    onClick={() => void ipc().actions.cancelAuthorize()}
                  >
                    {t('connect.actions.cancelSignIn')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-[30px] shrink-0 px-3 text-[13px]"
                    aria-label={t('connect.assistants.connectAria', { name: copy.name })}
                    disabled={pendingConnector !== null}
                    onClick={() => startConnector(c)}
                  >
                    {t('connect.connect')}
                  </Button>
                )}
              </section>
            );
          })}
          <section
            aria-label={t('connect.actions.custom.name')}
            className="flex min-w-0 items-start gap-3 rounded-xl border p-4"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
          >
            <ConnectGlyph kind="initials" initials={t('connect.actions.custom.initials')} />
            <div className="min-w-0 flex-1">
              <h3 className="text-[14px] font-medium">{t('connect.actions.custom.name')}</h3>
              <div className="mt-1.5 flex items-center gap-1.5" aria-hidden>
                {CUSTOM_BRANDS.map((b) => (
                  <BrandGlyph key={b} brand={b} size={26} />
                ))}
              </div>
              <p className="mt-1.5 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
                {t('connect.actions.custom.description')}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] shrink-0 px-3 text-[13px]"
              onClick={() => {
                setAddKey((k) => k + 1);
                setAddOpen(true);
              }}
            >
              <Plus aria-hidden />
              {t('connect.actions.custom.add')}
            </Button>
          </section>
        </div>
      )}
      {pendingConnector && (
        <p role="status" className="mt-3 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          {t('connect.actions.waitingForSignIn')}
        </p>
      )}
      {connectError && (
        <p role="alert" className="mt-3 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          {connectError}
        </p>
      )}

      {connections.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[13px] font-medium" style={{ color: 'var(--fg-2)' }}>
            {t('connect.actions.connectionsHeading')}
          </h3>
          <ul className="mt-2 flex flex-col gap-3">
            {connections.map((c) => (
              <li key={c.id}>
                <ActionConnectionCard connection={c} disabled={disabled} />
              </li>
            ))}
          </ul>
          <SettingRow
            label={t('connect.actions.autoSuggest.label')}
            description={t('connect.actions.autoSuggest.description')}
            noBorder
          >
            <Switch
              checked={data?.autoSuggest ?? true}
              disabled={disabled}
              aria-label={t('connect.actions.autoSuggest.label')}
              onCheckedChange={(v) => setAutoSuggest.mutate([v])}
            />
          </SettingRow>
        </div>
      )}

      <RecentActions />

      <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--fg-muted)' }}>
        {t('connect.actions.privacy')}
      </p>
      <AddEndpointDialog key={addKey} open={addOpen} onOpenChange={setAddOpen} />
    </section>
  );
}
