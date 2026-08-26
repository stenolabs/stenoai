import * as React from 'react';
import { Gem } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  useObsidianConflicts,
  useObsidianSyncSetting,
  useObsidianVaultPath,
  usePickObsidianVaultFolder,
  useSetObsidianSync,
  useSetObsidianVaultPath,
} from '@/hooks/useSettings';
import {
  useGetMcpKey,
  useMcpStatus,
  useRegenerateMcpKey,
  useSetMcpEnabled,
  useSetMcpKey,
  useSetMcpPort,
} from '@/hooks/useMcp';
import { cn } from '@/lib/utils';
import { COMPACT_BTN, COMPACT_INPUT, SectionHeading } from './primitives';

/**
 * Integrations settings (#413).
 * Contains:
 * 1. Obsidian vault sync — a one-way mirror of notes into a chosen vault folder.
 * 2. Local MCP server — a localhost-only Streamable HTTP endpoint for AI clients.
 */
export function IntegrationsTab() {
  // --- Obsidian sync ---
  const obsidianEnabled = useObsidianSyncSetting();
  const setObsidianEnabled = useSetObsidianSync();
  const vaultPath = useObsidianVaultPath();
  const setVaultPath = useSetObsidianVaultPath();
  const pickFolder = usePickObsidianVaultFolder();
  const conflicts = useObsidianConflicts();

  const chooseFolder = async () => {
    try {
      const folder = await pickFolder.mutateAsync();
      if (folder) setVaultPath.mutate(folder);
    } catch {
      // cancelled
    }
  };
  const clearFolder = () => setVaultPath.mutate('');

  const path = vaultPath.data || '';
  const conflictCount = conflicts.data ? Object.keys(conflicts.data).length : 0;

  // --- MCP server ---
  const mcpStatus = useMcpStatus();
  const setMcpEnabled = useSetMcpEnabled();
  const setMcpPort = useSetMcpPort();
  const setMcpKey = useSetMcpKey();
  const regenerateMcpKey = useRegenerateMcpKey();
  const getMcpKey = useGetMcpKey();

  const currentPort = mcpStatus.data?.port ?? 27127;
  const [portInput, setPortInput] = React.useState<string>(String(currentPort));
  const [portError, setPortError] = React.useState<string | null>(null);

  // Sync port input when backend status changes and input is not dirty
  React.useEffect(() => {
    if (mcpStatus.data?.port && !portError) {
      setPortInput(String(mcpStatus.data.port));
    }
  }, [mcpStatus.data?.port, portError]);

  const [revealedKey, setRevealedKey] = React.useState<string | null>(null);
  const [isRevealing, setIsRevealing] = React.useState(false);
  const [copiedKey, setCopiedKey] = React.useState(false);
  const [copiedEndpoint, setCopiedEndpoint] = React.useState(false);
  const [copiedSnippet, setCopiedSnippet] = React.useState(false);

  const [customKeyMode, setCustomKeyMode] = React.useState(false);
  const [customKeyInput, setCustomKeyInput] = React.useState('');
  const [customKeyError, setCustomKeyError] = React.useState<string | null>(null);
  const [confirmRegenerateOpen, setConfirmRegenerateOpen] = React.useState(false);

  const validatePortString = (val: string): boolean => {
    const trimmed = val.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
      setPortError('Port must be an integer between 1024 and 65535.');
      return false;
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num < 1024 || num > 65535) {
      setPortError('Port must be an integer between 1024 and 65535.');
      return false;
    }
    setPortError(null);
    return true;
  };

  const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPortInput(val);
    validatePortString(val);
  };

  const handlePortBlur = () => {
    if (validatePortString(portInput)) {
      const num = parseInt(portInput.trim(), 10);
      if (num !== mcpStatus.data?.port) {
        setMcpPort.mutate(num);
      }
    }
  };

  const handlePortKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  const handleRevealToggle = async () => {
    if (revealedKey) {
      setRevealedKey(null);
      return;
    }
    setIsRevealing(true);
    try {
      const key = await getMcpKey.mutateAsync();
      setRevealedKey(key);
    } catch {
      // Key fetch failed or cancelled
    } finally {
      setIsRevealing(false);
    }
  };

  const handleCopyKey = async () => {
    try {
      let keyToCopy = revealedKey;
      if (!keyToCopy) {
        keyToCopy = await getMcpKey.mutateAsync();
      }
      if (keyToCopy) {
        await navigator.clipboard.writeText(keyToCopy);
        setCopiedKey(true);
        window.setTimeout(() => setCopiedKey(false), 1500);
      }
    } catch {
      // Clipboard write failed
    }
  };

  const effectiveEndpoint =
    mcpStatus.data?.endpoint ?? `http://127.0.0.1:${currentPort}/mcp`;

  const handleCopyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(effectiveEndpoint);
      setCopiedEndpoint(true);
      window.setTimeout(() => setCopiedEndpoint(false), 1500);
    } catch {
      // Clipboard write failed
    }
  };

  const clientConfigSnippet = JSON.stringify(
    {
      mcpServers: {
        steno: {
          url: effectiveEndpoint,
          headers: {
            Authorization: `Bearer ${revealedKey || 'YOUR_API_KEY'}`,
          },
        },
      },
    },
    null,
    2,
  );

  const handleCopySnippet = async () => {
    try {
      await navigator.clipboard.writeText(clientConfigSnippet);
      setCopiedSnippet(true);
      window.setTimeout(() => setCopiedSnippet(false), 1500);
    } catch {
      // Clipboard write failed
    }
  };

  const handleSaveCustomKey = () => {
    const trimmed = customKeyInput.trim();
    if (!trimmed) {
      setCustomKeyError('API key cannot be empty.');
      return;
    }
    setMcpKey.mutate(trimmed);
    setRevealedKey(trimmed);
    setCustomKeyMode(false);
    setCustomKeyInput('');
    setCustomKeyError(null);
  };

  const handleCancelCustomKey = () => {
    setCustomKeyMode(false);
    setCustomKeyInput('');
    setCustomKeyError(null);
  };

  return (
    <section data-settings-tab="integrations">
      {/* ------------------------------------------------------------------ */}
      {/* Obsidian Sync Section */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="flex items-center gap-1.5 text-[14px] font-normal"
            style={{ color: 'var(--fg-1)' }}
          >
            Sync to Obsidian
            <Gem size={14} style={{ color: '#7c6cf5' }} aria-hidden />
          </div>
          <div className="mt-[2px] text-[13px]" style={{ color: 'var(--fg-2)' }}>
            Mirror your notes into an Obsidian vault folder as Markdown. One-way
            (Steno → vault); edits made in Obsidian are never overwritten.
          </div>
        </div>
        <Switch
          checked={obsidianEnabled.data ?? false}
          onCheckedChange={(v) => setObsidianEnabled.mutate(v)}
          disabled={obsidianEnabled.data === undefined}
          aria-label="Sync to Obsidian"
          className="mt-1 shrink-0"
        />
      </div>

      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            Vault folder
          </div>
          <div className="mb-2 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {path
              ? 'Notes are written here, under subfolders that mirror your Steno folders.'
              : 'Choose a folder inside your Obsidian vault to sync notes into.'}
          </div>
          {path && (
            <code
              className="block max-w-full truncate select-all font-mono text-[12px]"
              style={{ color: 'var(--fg-2)' }}
              title={path}
            >
              {path}
            </code>
          )}
        </div>
        <div className="flex shrink-0 gap-2 pt-1">
          <Button variant="outline" size="sm" className={COMPACT_BTN} onClick={chooseFolder}>
            Choose…
          </Button>
          {path && (
            <Button variant="ghost" size="sm" className={COMPACT_BTN} onClick={clearFolder}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {obsidianEnabled.data && !path && (
        <div className="py-3 text-[13px]" style={{ color: 'var(--fg-2)' }}>
          Sync is on but no vault folder is set yet — choose one above to start mirroring.
        </div>
      )}

      {conflictCount > 0 && (
        <div className="py-3 text-[13px]" style={{ color: 'var(--fg-2)' }}>
          <span style={{ color: 'var(--fg-1)' }}>
            {conflictCount} note{conflictCount === 1 ? '' : 's'} skipped
          </span>{' '}
          because the vault copy was edited in Obsidian. Those edits were kept — Steno
          won’t overwrite them.
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Local MCP Server Section */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeading>Local MCP server</SectionHeading>
      <p
        className="text-[13px] leading-[1.5] py-2"
        style={{ color: 'var(--fg-2)' }}
        data-testid="mcp-disclosure-copy"
      >
        Expose your notes and transcripts to local AI tools (such as Claude Desktop
        or Cursor) via the Model Context Protocol. Listens on localhost (127.0.0.1)
        only, stays off until you turn it on, and requires an API key on every
        request. An authorised client can read your notes, transcripts, and
        folders, and ask questions across them.
      </p>

      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)' }}
          >
            Enable local MCP server
          </div>
          <div className="mt-[2px] text-[13px]" style={{ color: 'var(--fg-2)' }}>
            Accept incoming connections from local Model Context Protocol clients.
          </div>
        </div>
        <Switch
          checked={mcpStatus.data?.enabled ?? false}
          onCheckedChange={(v) => setMcpEnabled.mutate(v)}
          disabled={mcpStatus.data === undefined}
          aria-label="Local MCP server"
          data-testid="mcp-toggle"
          className="mt-1 shrink-0"
        />
      </div>

      {/* Endpoint URL (shown once enabled / running) */}
      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            Server endpoint
          </div>
          <div className="mb-2 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            {mcpStatus.data?.running
              ? 'The server is running locally and ready for requests.'
              : mcpStatus.data?.enabled
                ? 'Server is starting…'
                : 'Server is stopped (turns on when enabled above).'}
          </div>
          <code
            className="block max-w-full truncate select-all font-mono text-[12px]"
            style={{ color: 'var(--fg-2)' }}
            title={effectiveEndpoint}
            data-testid="mcp-endpoint-url"
          >
            {effectiveEndpoint}
          </code>
        </div>
        <div className="flex shrink-0 gap-2 pt-1">
          {/* Copy is offered only while the server is actually running. The URL
              stays visible when stopped (it tells you which port will be used),
              but handing someone a one-click copy of an endpoint nothing is
              listening on just sends them to configure a client that fails. */}
          <Button
            variant="outline"
            size="sm"
            className={COMPACT_BTN}
            onClick={handleCopyEndpoint}
            disabled={!mcpStatus.data?.running}
            title={
              mcpStatus.data?.running
                ? 'Copy the endpoint URL'
                : 'Turn the server on to copy its endpoint'
            }
            data-testid="mcp-copy-endpoint-btn"
          >
            {copiedEndpoint ? 'Copied' : 'Copy URL'}
          </Button>
        </div>
      </div>

      {/* Port row with inline validation */}
      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            Port
          </div>
          <div className="mb-2 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            Local TCP port for the MCP endpoint (1024–65535).
          </div>
          {portError && (
            <div
              className="mt-1 text-[12px]"
              style={{ color: 'var(--red-600)' }}
              data-testid="mcp-port-error"
            >
              {portError}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={portInput}
            onChange={handlePortChange}
            onBlur={handlePortBlur}
            onKeyDown={handlePortKeyDown}
            className={cn(COMPACT_INPUT, 'w-[90px] font-mono text-right')}
            aria-label="MCP port"
            data-testid="mcp-port-input"
          />
        </div>
      </div>

      {/* API key row */}
      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            API key
          </div>
          <div className="mb-2 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            Required in the Authorization header (Bearer token) for all incoming MCP
            requests.
          </div>

          {customKeyMode ? (
            <div className="mt-2 space-y-2">
              <Input
                type="password"
                value={customKeyInput}
                onChange={(e) => {
                  setCustomKeyInput(e.target.value);
                  if (customKeyError) setCustomKeyError(null);
                }}
                placeholder="Paste your API key"
                className={COMPACT_INPUT}
                data-testid="mcp-custom-key-input"
                autoFocus
              />
              {customKeyError && (
                <div
                  className="text-[12px]"
                  style={{ color: 'var(--red-600)' }}
                  data-testid="mcp-custom-key-error"
                >
                  {customKeyError}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className={COMPACT_BTN}
                  onClick={handleSaveCustomKey}
                  data-testid="mcp-save-custom-key-btn"
                >
                  Save key
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={COMPACT_BTN}
                  onClick={handleCancelCustomKey}
                  data-testid="mcp-cancel-custom-key-btn"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              {revealedKey ? (
                <code
                  className="block max-w-full truncate select-all font-mono text-[12px]"
                  style={{ color: 'var(--fg-1)' }}
                  data-testid="mcp-key-revealed"
                  title={revealedKey}
                >
                  {revealedKey}
                </code>
              ) : (
                <code
                  className="block max-w-full truncate font-mono text-[12px]"
                  style={{ color: 'var(--fg-2)' }}
                  data-testid="mcp-key-masked"
                >
                  ••••••••••••••••••••••••••••••••
                </code>
              )}
            </div>
          )}
        </div>

        {!customKeyMode && (
          <div className="flex shrink-0 flex-wrap gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className={COMPACT_BTN}
              onClick={handleRevealToggle}
              disabled={isRevealing}
              data-testid="mcp-reveal-key-btn"
            >
              {isRevealing ? 'Revealing…' : revealedKey ? 'Hide' : 'Reveal'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={COMPACT_BTN}
              onClick={handleCopyKey}
              data-testid="mcp-copy-key-btn"
            >
              {copiedKey ? 'Copied' : 'Copy'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={COMPACT_BTN}
              onClick={() => setConfirmRegenerateOpen(true)}
              data-testid="mcp-regenerate-key-btn"
            >
              Regenerate…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={COMPACT_BTN}
              onClick={() => {
                setCustomKeyMode(true);
                setCustomKeyInput('');
                setCustomKeyError(null);
              }}
              data-testid="mcp-custom-key-btn"
            >
              Paste key
            </Button>
          </div>
        )}
      </div>

      {/* Client configuration snippet */}
      <div
        className="flex items-start justify-between gap-6 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-normal"
            style={{ color: 'var(--fg-1)', marginBottom: 2 }}
          >
            Client configuration
          </div>
          <div className="mb-2 text-[13px]" style={{ color: 'var(--fg-2)' }}>
            Add this configuration to your MCP client (e.g. Claude Desktop or Cursor):
          </div>
          <pre
            className="block max-w-full overflow-x-auto rounded-[6px] p-2.5 font-mono text-[12px]"
            style={{
              background: 'var(--surface-sunken)',
              color: 'var(--fg-1)',
              border: '1px solid var(--border-subtle)',
            }}
            data-testid="mcp-client-config"
          >
            {clientConfigSnippet}
          </pre>
        </div>
        <div className="flex shrink-0 gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            className={COMPACT_BTN}
            onClick={handleCopySnippet}
            data-testid="mcp-copy-config-btn"
          >
            {copiedSnippet ? 'Copied' : 'Copy config'}
          </Button>
        </div>
      </div>

      {/* Confirm Regenerate Dialog */}
      <ConfirmDialog
        open={confirmRegenerateOpen}
        onOpenChange={setConfirmRegenerateOpen}
        title="Regenerate MCP API key?"
        description="Regenerating the API key will immediately disconnect any active MCP clients (such as Claude Desktop or Cursor). You will need to update them with the new key."
        confirmLabel="Regenerate"
        destructive
        onConfirm={async () => {
          await regenerateMcpKey.mutateAsync();
          setRevealedKey(null);
        }}
      />
    </section>
  );
}
