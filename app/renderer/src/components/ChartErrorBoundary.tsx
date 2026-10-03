import * as React from 'react';

/** Keep a chart failure local to its block and retain the original data. */
export class ChartErrorBoundary extends React.Component<
  {
    children: React.ReactNode;
    fallback: React.ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
