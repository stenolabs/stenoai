import * as React from 'react';
import { Check, Mail, Plus, ServerCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  useActionsOverview,
  useConnectConnector,
  useSetConnectionEnabled,
} from '@/hooks/useActions';
import { actionErrorMessage } from '@/lib/actionErrors';
import { ipc, type ActionConnector, type ActionConnectorId } from '@/lib/ipc';
import { navigate } from '@/lib/router';
import { t } from '@/i18n';
import { AddEndpointDialog } from './AddEndpointDialog';
import { BrandGlyph, ConnectGlyph, IconGlyph } from './ConnectGlyph';
import type { BrandSlug, MulticolorBrandSlug } from './brandLogos';

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
  const [addOpen, setAddOpen] = React.useState(false);
  const [addKey, setAddKey] = React.useState(0);
  const [pendingConnector, setPendingConnector] = React.useState<ActionConnectorId | null>(null);
  // A failed sign-in shows on the card that started it.
  const [connectError, setConnectError] = React.useState<{
    id: ActionConnectorId;
    message: string;
  } | null>(null);

  const data = overview.data;
  const policy = data?.policy;
  const disabled = policy ? !policy.actionsEnabled : false;
  const allConnections = data?.connections ?? [];
  // The built-in Email drafts are a card of their own, not a connection to manage.
  const emailDrafts = allConnections.find((c) => c.kind === 'email' && c.builtin) ?? null;
  const connections = allConnections.filter((c) => !c.builtin);
  const connectors = data?.connectors ?? [];
  const setEnabled = useSetConnectionEnabled();

  const startConnector = (c: ActionConnector) => {
    setConnectError(null);
    setPendingConnector(c.id);
    connect.mutate([c.id], {
      onError: (e) => setConnectError({ id: c.id, message: actionErrorMessage(e) }),
      onSettled: () => setPendingConnector(null),
    });
  };

  return (
    <section aria-labelledby="connect-actions-heading" className="mt-10">
      <h2 id="connect-actions-heading" data-tip-anchor="connect-actions" className="text-[15px] font-medium">
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
          {emailDrafts && !emailDrafts.blockedByPolicy && (
            <section
              aria-label={t('connect.actions.email.name')}
              className="flex min-w-0 items-start gap-3 rounded-xl border p-4"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}
            >
              <IconGlyph icon={Mail} />
              <div className="min-w-0 flex-1">
                <h3 className="text-[14px] font-medium">{t('connect.actions.email.name')}</h3>
                <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--fg-2)' }}>
                  {t('connect.actions.email.description')}
                </p>
              </div>
              <Switch
                checked={emailDrafts.enabled}
                aria-label={t('connect.actions.email.enableAria')}
                onCheckedChange={(v) => setEnabled.mutate([emailDrafts.id, v])}
              />
            </section>
          )}
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
                  {connectError?.id === c.id && (
                    <p
                      role="alert"
                      className="mt-1.5 text-[12.5px] leading-snug"
                      style={{ color: 'var(--danger)' }}
                    >
                      {connectError.message}
                    </p>
                  )}
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
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border"
              style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-subtle)', color: 'var(--fg-1)' }}
            >
              <ServerCog className="size-[18px]" strokeWidth={1.7} />
            </span>
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

      {connections.length > 0 && (
        <p className="mt-4 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          <button
            type="button"
            className="underline underline-offset-2 hover:text-[color:var(--fg-1)]"
            onClick={() => navigate('/settings?tab=connectors')}
          >
            {t('connect.actions.manageConnections')}
          </button>
        </p>
      )}

      <AddEndpointDialog
        key={addKey}
        open={addOpen}
        onOpenChange={setAddOpen}
        allowLocal={policy?.localCommandsAllowed !== false}
      />
    </section>
  );
}
