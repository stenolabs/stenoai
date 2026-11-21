import * as React from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ipc } from '@/lib/ipc';
import { t } from '@/i18n';

interface DialogState {
  type: 'recording' | 'processing';
  jobCount?: number;
}

export function QuitDialog() {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<DialogState>({ type: 'recording' });

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.stenoai) return;
    return ipc().on.showQuitDialog((payload) => {
      setState({ type: payload.type, jobCount: payload.jobCount });
      setOpen(true);
    });
  }, []);

  const respond = (confirmed: boolean) => {
    setOpen(false);
    ipc().dialog.respondQuit(confirmed);
  };

  const isRecording = state.type === 'recording';
  const title = isRecording ? t('quitDialog.recording.title') : t('quitDialog.processing.title');
  const count = state.jobCount ?? 1;
  const body = isRecording
    ? t('quitDialog.recording.body')
    : count !== 1
      ? t('quitDialog.processing.body.other', { count })
      : t('quitDialog.processing.body.one', { count });
  const confirmLabel = isRecording ? t('quitDialog.recording.confirm') : t('quitDialog.processing.confirm');

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) respond(false);
      }}
      title={title}
      description={body}
      confirmLabel={confirmLabel}
      cancelLabel={t('quitDialog.cancel')}
      destructive
      onConfirm={() => respond(true)}
    />
  );
}
