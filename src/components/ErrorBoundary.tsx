import React from 'react';

interface State {
  error: Error | null;
}

/**
 * Catches render errors so a single bad message never blanks the whole side panel.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallbackText?: string },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[Any Agent] UI render error:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="m-3 p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-xs text-rose-200 space-y-2">
          <div className="font-semibold">{this.props.fallbackText || 'Something went wrong rendering this view.'}</div>
          <div className="font-mono text-[10px] text-rose-300/80 break-words">
            {this.state.error.message}
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="px-2.5 py-1 rounded-md bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

