import * as React from 'react';
import { Button } from '@/components/ui/button';
import { KbdKey } from '@/components/ui/kbd';
import { useRecordHotkeySetting, useSetRecordHotkeyAccelerator } from '@/hooks/useSettings';
import {
  DEFAULT_RECORD_ACCELERATOR,
  acceleratorKeys,
  captureAccelerator,
  formatAccelerator,
} from '@/lib/accelerator';
import { ResultError } from '@/lib/result';
import { t } from '@/i18n';
import { SettingRow } from './primitives';

type Problem = { kind: 'in-use'; shortcut: string } | { kind: 'needs-modifier' } | { kind: 'save' } | null;

/**
 * Settings → Preferences "Record shortcut": click the keys, press a new
 * combination, and main registers it live. A combination another app owns is
 * refused with a warning and the old shortcut keeps working.
 */
export function RecordShortcutRow() {
  const hotkey = useRecordHotkeySetting();
  const setAccel = useSetRecordHotkeyAccelerator();
  const [capturing, setCapturing] = React.useState(false);
  const [problem, setProblem] = React.useState<Problem>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  const accel = hotkey.data?.accelerator ?? DEFAULT_RECORD_ACCELERATOR;
  const isCustom = Boolean(hotkey.data?.customAccelerator);
  const enabled = hotkey.data?.enabled ?? true;

  const save = (value: string | null) => {
    setProblem(null);
    setAccel.mutate(value, {
      onError: (e) => {
        if (e instanceof ResultError && e.code === 'in-use' && value) {
          setProblem({ kind: 'in-use', shortcut: formatAccelerator(value) });
        } else if (e instanceof ResultError && e.code === 'invalid') {
          setProblem({ kind: 'needs-modifier' });
        } else {
          setProblem({ kind: 'save' });
        }
      },
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    // While capturing, every key belongs to the capture (Tab included), so the
    // combination is never also typed into the page.
    e.preventDefault();
    e.stopPropagation();
    const result = captureAccelerator(e);
    if (result.kind === 'cancel') {
      setCapturing(false);
      return;
    }
    if (result.kind === 'needs-modifier') {
      setProblem({ kind: 'needs-modifier' });
      return;
    }
    if (result.kind === 'accelerator') {
      setCapturing(false);
      if (result.accelerator !== accel) save(result.accelerator);
    }
  };

  const problemText =
    problem?.kind === 'in-use'
      ? t('settings.general.recordShortcut.inUse', { shortcut: problem.shortcut })
      : problem?.kind === 'needs-modifier'
        ? t('settings.general.recordShortcut.needsModifier')
        : problem?.kind === 'save'
          ? t('settings.general.recordShortcut.saveError')
          : null;

  return (
    <SettingRow
      label={t('settings.general.recordShortcut.label')}
      description={
        <>
          {t('settings.general.recordShortcut.description')}
          {problemText && (
            <span role="alert" className="mt-1 block" style={{ color: 'var(--fg-1)' }}>
              {problemText}
            </span>
          )}
        </>
      }
      muted={!enabled}
      noBorder
    >
      <div className="flex items-center gap-2">
        {isCustom && !capturing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-[28px] px-2 text-[12.5px]"
            disabled={!enabled || setAccel.isPending}
            onClick={() => save(null)}
          >
            {t('settings.general.recordShortcut.reset')}
          </Button>
        )}
        <button
          ref={buttonRef}
          type="button"
          data-testid="record-shortcut-capture"
          // App-wide hotkeys (⌘K palette) stand aside while this has focus.
          data-shortcut-capture=""
          aria-label={
            capturing
              ? t('settings.general.recordShortcut.pressKeys')
              : t('settings.general.recordShortcut.change', { shortcut: formatAccelerator(accel) })
          }
          disabled={!enabled || hotkey.data === undefined || setAccel.isPending}
          onClick={() => {
            setProblem(null);
            setCapturing((v) => !v);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setCapturing(false)}
          className="inline-flex h-[30px] min-w-[96px] items-center justify-center gap-1 rounded-md border px-2.5 text-[12.5px] transition-colors hover:bg-[color:var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
          style={{
            borderColor: capturing ? 'var(--fg-1)' : 'var(--border-subtle)',
            color: 'var(--fg-2)',
          }}
        >
          {capturing ? (
            <span>{t('settings.general.recordShortcut.pressKeys')}</span>
          ) : (
            acceleratorKeys(accel).map((k, i) => <KbdKey key={`${k}-${i}`}>{k}</KbdKey>)
          )}
        </button>
      </div>
    </SettingRow>
  );
}
