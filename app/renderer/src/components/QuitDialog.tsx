import * as React from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert } from 'lucide-react';
import { ipc } from '@/lib/ipc';
import { useTranslation } from '@/i18n';
interface DialogState {
  type: 'recording' | 'processing';
  jobCount?: number;
}

export function QuitDialog() {
  const { t } = useTranslation();
  const [mounted, setMounted] = React.useState(false);
  const [visible, setVisible] = React.useState(false);
  const [state, setState] = React.useState<DialogState>({ type: 'recording' });

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.stenoai) return;
    return ipc().on.showQuitDialog((payload) => {
      setState({ type: payload.type, jobCount: payload.jobCount });
      setMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    });
  }, []);

  const dismiss = (confirmed: boolean) => {
    setVisible(false);
    setTimeout(() => setMounted(false), 200);
    ipc().dialog.respondQuit(confirmed);
  };

  const handleCancel = () => dismiss(false);
  const handleConfirm = () => dismiss(true);

  React.useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mounted]);

  if (!mounted) return null;

  const host = document.getElementById('dialog-host');
  if (!host) return null;

  const isRecording = state.type === 'recording';
  const title = isRecording ? t('dialogs.quitWhileRecordingTitle') : t('dialogs.quitWhileProcessingTitle');
  const count = state.jobCount ?? 1;
  const body = isRecording
    ? t('dialogs.quitWhileRecordingBody')
    : count === 1
      ? t('dialogs.quitWhileProcessingBodySingle')
      : t('dialogs.quitWhileProcessingBodyPlural', { count });
  const confirmLabel = isRecording ? t('dialogs.quitWhileRecordingConfirm') : t('dialogs.quitWhileProcessingConfirm');

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) handleCancel(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.25)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 200ms cubic-bezier(0.2,0,0,1)',
      }}
    >
      <div
        style={{
          background: 'var(--surface-raised)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--border-subtle)',
          width: 360,
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          transform: visible ? 'translateY(0)' : 'translateY(8px)',
          transition: 'transform 200ms cubic-bezier(0.2,0,0,1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <CircleAlert
            size={18}
            strokeWidth={1.5}
            style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 500, color: 'var(--fg-1)', lineHeight: 1.3 }}>
              {title}
            </p>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              {body}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <CancelButton onClick={handleCancel} />
          <ConfirmButton onClick={handleConfirm} label={confirmLabel} />
        </div>
      </div>
    </div>,
    host,
  );
}

function CancelButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 32,
        padding: '0 14px',
        borderRadius: 8,
        border: '1px solid var(--border-strong)',
        background: hovered ? 'var(--surface-hover)' : 'transparent',
        color: 'var(--fg-1)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        transition: 'background 120ms cubic-bezier(0.2,0,0,1)',
      }}
    >
      {t('common.cancel')}
    </button>
  );
}

function ConfirmButton({ onClick, label }: { onClick: () => void; label: string }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: 32,
        padding: '0 14px',
        borderRadius: 8,
        border: 0,
        background: 'var(--danger)',
        color: '#fff',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        filter: hovered ? 'brightness(0.9)' : 'none',
        transition: 'filter 120ms cubic-bezier(0.2,0,0,1)',
      }}
    >
      {label}
    </button>
  );
}
