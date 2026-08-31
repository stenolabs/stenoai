import * as React from 'react';
import { ipc } from '@/lib/ipc';
import { useTheme } from '@/hooks/useTheme';
import { AppIcon } from '@/components/ui/app-icon';
import { AlertCircle, CheckCircle2, Mic, Info } from 'lucide-react';

export type NotificationIconType = 'app' | 'alert' | 'success' | 'recording';

interface NotificationAction {
  id: string;
  text: string;
  type?: 'primary' | 'secondary';
}

interface NotificationData {
  id?: string;
  title: string;
  body?: string;
  time?: string;
  meeting_url?: string;
  attendees?: string;
  /** The pre-meeting reminder keeps its bespoke Join / focus behavior + its own
   *  analytics; every other notification is a "generic" toast routed through the
   *  action/body-click bridge and tracked entirely main-side. */
  premeeting?: boolean;
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
): { Icon: IconComponent; className: string } | null {
  switch (iconType) {
    case 'alert':
      return { Icon: AlertCircle, className: 'text-red-500' };
    case 'success':
      return { Icon: CheckCircle2, className: 'text-green-500' };
    case 'recording':
      return { Icon: Mic, className: 'text-blue-500' };
    case 'app':
    case undefined:
      return null; // brand AppIcon
    default:
      return { Icon: Info, className: 'text-gray-400' };
  }
}

export function NotificationToast() {
  useTheme();
  const [data, setData] = React.useState<NotificationData | null>(null);

  React.useLayoutEffect(() => {
    const off = ipc().on.showNotification((newData) => {
      setData(newData);
    });
    // The main process returns the payload only after this subscription exists.
    // This avoids racing React's layout-effect commit against window load events.
    ipc().notification.rendererReady();
    return off;
  }, []);

  if (!data) return null;

  const isPremeeting = !!data.premeeting;
  const hasValidUrl = !!(data.meeting_url && /^https?:\/\//i.test(data.meeting_url));
  const hasActions = !!(data.actions && data.actions.length > 0);

  const handleClose = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    // Pre-meeting tracks its own dismiss (main only counts a PASSIVE dismiss for
    // it). Generic notifications are tracked entirely main-side via
    // trackNotificationLifecycle, so the renderer must NOT double-track them.
    if (isPremeeting) {
      ipc().analytics.track('notification_dismissed', { type: 'premeeting' });
    }
    ipc().notification.close();
  };

  const handleJoin = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    ipc().analytics.track('notification_clicked', { type: 'premeeting' });
    if (hasValidUrl) {
      ipc().shell.openExternal(data.meeting_url!);
    }
    ipc().recording.start(data.title, 'notification_click');
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
      ipc().analytics.track('notification_clicked', { type: 'premeeting' });
      ipc().window.focus();
    } else {
      ipc().notification.bodyClicked(data.id);
    }
    ipc().notification.close();
  };

  const getEventColor = (title: string) => {
    if (data.color) return data.color;
    const colors = ['#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#EF4444', '#06B6D4'];
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
      hash = title.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const barColor = getEventColor(data.title);
  const iconMeta = notificationIconMeta(data.iconType);

  return (
    <>
      <style>{`
        html, body, #root {
          background: transparent !important;
        }
      `}</style>
      <div className="flex h-screen w-screen items-center justify-center bg-transparent p-3">
        <div
          className="group relative flex w-full cursor-pointer items-center justify-between rounded-[20px] bg-white p-2.5 pr-3 border border-gray-200 shadow-sm dark:bg-[#1E1E1E] dark:border-white/10"
          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
          onClick={handleBody}
        >
          <button
            onClick={handleClose}
            className="absolute -top-1.5 -left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-sm border border-gray-200 text-gray-500 opacity-0 transition-opacity hover:bg-gray-50 hover:text-gray-700 group-hover:opacity-100 dark:bg-[#2C2C2E] dark:border-white/10 dark:text-gray-400 dark:hover:bg-[#3C3C3E] dark:hover:text-gray-200"
            title="Close"
          >
            <svg width="8" height="8" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>

          <div className="flex items-center min-w-0">
            {/* Leading Steno brand mark so every toast is identifiable as Steno
                — the action/status toasts otherwise show a button or a ✓ in the
                right slot and nothing said "Steno", especially floating top-right
                with the window hidden. */}
            <div className="shrink-0 ml-1 text-gray-800 dark:text-gray-100">
              <AppIcon size={20} color="currentColor" />
            </div>
            <div
              className="h-8 w-1 rounded-full ml-2 shrink-0"
              style={{ backgroundColor: barColor }}
            ></div>
            <div className="flex flex-col justify-center ml-3 min-w-0">
              <span className="text-[14px] font-medium text-gray-900 tracking-tight leading-tight truncate max-w-[220px] dark:text-gray-100">
                {data.title}
              </span>
              {(data.body || data.time) && (
                <span className="text-[12px] font-normal text-gray-500 leading-tight mt-0.5 truncate max-w-[220px] dark:text-gray-400">
                  {data.body || data.time}
                </span>
              )}
            </div>
          </div>

          {hasActions ? (
            <div className="flex items-center gap-1.5 shrink-0 pl-2">
              {data.actions!.map((action) => (
                <button
                  key={action.id}
                  onClick={(e) => handleGenericAction(action.id, e)}
                  className="flex items-center justify-center rounded-[10px] border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-900 transition-all hover:bg-gray-50 hover:shadow-sm active:bg-gray-100 active:scale-[0.98] shrink-0 dark:border-white/10 dark:bg-[#2C2C2E] dark:text-gray-100 dark:hover:bg-[#3C3C3E] dark:active:bg-[#1C1C1E]"
                >
                  {action.text}
                </button>
              ))}
            </div>
          ) : isPremeeting ? (
            hasValidUrl ? (
              <button
                onClick={handleJoin}
                className="flex items-center gap-2 rounded-[10px] border border-gray-200 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-900 transition-all hover:bg-gray-50 hover:shadow-sm active:bg-gray-100 active:scale-[0.98] shrink-0 dark:border-white/10 dark:bg-[#2C2C2E] dark:text-gray-100 dark:hover:bg-[#3C3C3E] dark:active:bg-[#1C1C1E]"
              >
                <ProfessionalCameraIcon className="h-5 w-5" backgroundColor={barColor} />
                <span>Join &amp; take notes</span>
              </button>
            ) : null
          ) : (
            <div className="flex items-center justify-center shrink-0 pr-1 text-gray-500 dark:text-gray-400">
              {iconMeta ? (
                <iconMeta.Icon size={20} className={iconMeta.className} />
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
