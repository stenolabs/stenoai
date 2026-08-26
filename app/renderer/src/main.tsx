import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import './globals.css';
import { App } from './App';
import { isMac } from './lib/utils';
import { queryClient } from './lib/queryClient';
import { TooltipProvider } from './components/ui/tooltip';
import { I18nProvider } from './i18n';
// Platform hook for CSS. macOS gets the 82px traffic-light inset on the sidebar
// top band; Windows/Linux have no traffic lights, so they align to the edge.
document.documentElement.classList.toggle('is-mac', isMac);

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'red' }}>
          <strong>Renderer crashed:</strong>{'\n\n'}
          {this.state.error.stack ?? this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

import { NotificationToast } from './components/NotificationToast';

const isNotification = window.location.hash === '#/notification';

if (isNotification) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <NotificationToast />
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <TooltipProvider delayDuration={50}>
              <App />
            </TooltipProvider>
          </I18nProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
}
