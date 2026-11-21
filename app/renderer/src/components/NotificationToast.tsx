import * as React from 'react';
import { ipc } from '@/lib/ipc';
import { useTheme } from '@/hooks/useTheme';
import { t } from '@/i18n';
import { AppIcon } from '@/components/ui/app-icon';
import { AlertCircle, CheckCircle2, ExternalLink, Mic, Info } from 'lucide-react';

export type NotificationIconType = 'app' | 'alert' | 'success' | 'recording';

interface NotificationAction {
  id: string;
  text: string;
  type?: 'primary' | 'secondary';
}

interface NotificationData {
  id?: string;
  title: string;
  detail?: string;
  body?: string;
  time?: string;
  meeting_url?: string;
  attendees?: string;
  /** The pre-meeting reminder keeps its bespoke Join / focus behavior + its own
   *  analytics; every other notification is a "generic" toast routed through the
   *  action/body-click bridge and tracked entirely main-side. */
  premeeting?: boolean;
  /** 'ask' = auto-open prompt: the button opens the link only, never starts a recording. */
  autoOpen?: 'ask';
  event_id?: string;
  iconType?: NotificationIconType;
  color?: string;
  actions?: NotificationAction[];
}

type IconComponent = React.ComponentType<{ size?: number; className?: string }>;

/**
 * Map an `iconType` to the lucide icon + tint shown on a generic toast that has
 * no action buttons. `'app'` (or unset) renders the brand mark instead, so this
 * returns `null` for that case. Exported + pure for unit testing.
 */
export function notificationIconMeta(
  iconType?: NotificationIconType,
): { Icon: IconComponent; color: string } | null {
  switch (iconType) {
    case 'alert':
      return { Icon: AlertCircle, color: 'var(--danger)' };
    case 'success':
      return { Icon: CheckCircle2, color: 'var(--success)' };
    case 'recording':
      return { Icon: Mic, color: 'var(--recording)' };
    case 'app':
    case undefined:
      return null; // brand AppIcon
    default:
      return { Icon: Info, color: 'var(--fg-2)' };
  }
}

export function NotificationToast() {
  useTheme();
  const [data, setData] = React.useState<NotificationData | null>(null);

  React.useLayoutEffect(() => {
    const off = ipc().on.showNotification((newData) => {
      setData(newData);
    });
    return off;
  }, []);

  if (!data) return null;

  const isPremeeting = !!data.premeeting;
  const premeetingType = data.autoOpen === 'ask' ? 'meeting_open_ask' : 'premeeting';
  const hasValidUrl = !!(data.meeting_url && /^https?:\/\//i.test(data.meeting_url));
  const hasActions = !!(data.actions && data.actions.length > 0);

  const handleClose = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    // Pre-meeting tracks its own dismiss (main only counts a PASSIVE dismiss for
    // it). Generic notifications are tracked entirely main-side via
    // trackNotificationLifecycle, so the renderer must NOT double-track them.
    if (isPremeeting) {
      ipc().analytics.track('notification_dismissed', { type: premeetingType });
    }
    ipc().notification.close();
  };

  const handleJoin = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    ipc().analytics.track('notification_clicked', { type: 'premeeting' });
    if (hasValidUrl) {
      ipc().shell.openExternal(data.meeting_url!, data.event_id);
    }
    ipc().recording.start(data.title, 'notification_click');
    ipc().notification.close();
  };

  const handleOpen = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    ipc().analytics.track('notification_clicked', { type: 'meeting_open_ask' });
    void ipc().shell.openExternal(data.meeting_url!, data.event_id);
    ipc().notification.close();
  };

  const handleGenericAction = (actionId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    // The button's side effect lives on the main-side notification's 'action'
    // handler; the renderer only relays the tap, then closes.
    ipc().notification.actionClicked(actionId, data.id);
    ipc().notification.close();
  };

  const handleBody = () => {
    if (isPremeeting) {
      ipc().analytics.track('notification_clicked', { type: premeetingType });
      ipc().window.focus();
    } else {
      ipc().notification.bodyClicked(data.id);
    }
    ipc().notification.close();
  };

  // Only a calendar event's own colour means something here. Everything else
  // used to get a colour hashed from its title, which read as meaningful and
  // broke the paper + ink palette; it now gets the neutral ink bar (#412). The
  // iconType tint already carries a toast's state.
  const barColor = data.color;
  const iconMeta = notificationIconMeta(data.iconType);

  return (
    <>
      <style>{`
        html, body, #root {
          background: transparent !important;
        }
      `}</style>
      <div className="flex h-screen w-screen items-center justify-center bg-transparent p-3" role="status" aria-live="polite">
        <div
          className="group relative flex w-full cursor-pointer items-center justify-between rounded-[20px] p-2.5 pr-3 border shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            fontFamily: 'var(--font-sans)',
            background: 'var(--surface-raised)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--fg-1)',
          }}
          onClick={handleBody}
        >
          <button
            type="button"
            onClick={handleClose}
            aria-label={t('notificationToast.close')}
            className="absolute -top-2 -left-2 flex h-6 w-6 items-center justify-center rounded-full border shadow-sm opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-[color:var(--surface-hover)]"
            style={{
              background: 'var(--surface-raised)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--fg-2)',
            }}
            title={t('notificationToast.close')}
          >
            <svg width="8" height="8" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>

          <div className="flex items-center min-w-0">
            {/* Leading Steno brand mark so every toast is identifiable as Steno
                — the action/status toasts otherwise show a button or a ✓ in the
                right slot and nothing said "Steno", especially floating top-right
                with the window hidden. */}
            <div className="shrink-0 ml-1" style={{ color: 'var(--fg-1)' }}>
              <AppIcon size={20} color="currentColor" />
            </div>
            <div
              data-testid="toast-accent-bar"
              className="h-8 w-1 rounded-full ml-2 shrink-0"
              style={{ backgroundColor: barColor || 'var(--border-strong)' }}
            ></div>
            <div className="flex flex-col justify-center ml-3 min-w-0">
              <span
                className="text-[14px] font-medium tracking-tight leading-tight truncate max-w-[220px]"
                style={{ color: 'var(--fg-1)' }}
              >
                {[data.title, data.detail].filter(Boolean).join(' · ')}
              </span>
              {(data.body || data.time) && (
                <span
                  className="text-[12px] font-normal leading-tight mt-0.5 truncate max-w-[220px]"
                  style={{ color: 'var(--fg-2)' }}
                >
                  {data.body || data.time}
                </span>
              )}
            </div>
          </div>

          {hasActions ? (
            <div className="flex items-center gap-1.5 shrink-0 pl-2">
              {data.actions!.map((action) => (
                <button
                  type="button"
                  key={action.id}
                  onClick={(e) => handleGenericAction(action.id, e)}
                  className="flex items-center justify-center rounded-[10px] border px-3 py-1.5 text-[12px] font-medium transition-all hover:bg-[color:var(--surface-hover)] hover:shadow-sm active:scale-[0.98] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-raised)',
                    color: 'var(--fg-1)',
                  }}
                >
                  {action.text}
                </button>
              ))}
            </div>
          ) : isPremeeting ? (
            hasValidUrl ? (
              <button
                type="button"
                onClick={data.autoOpen === 'ask' ? handleOpen : handleJoin}
                className="flex items-center gap-2 rounded-[10px] border px-3 py-1.5 text-[13px] font-medium transition-all hover:bg-[color:var(--surface-hover)] hover:shadow-sm active:scale-[0.98] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-raised)',
                  color: 'var(--fg-1)',
                }}
              >
                {data.autoOpen === 'ask' ? (
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ProfessionalCameraIcon className="h-5 w-5" backgroundColor={barColor ?? '#1B1B19'} />
                )}
                <span>
                  {data.autoOpen === 'ask' ? t('notificationToast.open') : 'Join & take notes'}
                </span>
              </button>
            ) : null
          ) : (
            <div className="flex items-center justify-center shrink-0 pr-1" style={{ color: 'var(--fg-2)' }}>
              {iconMeta ? (
                <span className="flex" style={{ color: iconMeta.color }} aria-hidden="true">
                  <iconMeta.Icon size={20} />
                </span>
              ) : (
                <AppIcon size={24} color="currentColor" />
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ProfessionalCameraIcon({ className, backgroundColor = '#10B981' }: { className?: string; backgroundColor?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5.5" fill={backgroundColor} />
      <path d="M15.5 10.5V8C15.5 7.17157 14.8284 6.5 14 6.5H6C5.17157 6.5 4.5 7.17157 4.5 8V16C4.5 16.8284 5.17157 17.5 6 17.5H14C14.8284 17.5 15.5 16.8284 15.5 16V13.5L19.5 16.5V7.5L15.5 10.5Z" fill="white" />
    </svg>
  );
}
