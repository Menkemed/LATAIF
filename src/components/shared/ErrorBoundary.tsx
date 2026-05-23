import { Component, type ErrorInfo, type ReactNode } from 'react';

// React fängt Render-Errors NICHT von alleine — wenn irgendwo eine Page wirft,
// unmountet React die ganze Tree → komplett weiße Seite, kein Hinweis was passiert ist.
// Diese Boundary fängt das, zeigt die Fehlermeldung + Stack und einen Reload-Button.

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info);
    this.setState({ info });
  }

  reset = (): void => this.setState({ error: null, info: null });

  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    const stack = this.state.info?.componentStack || err.stack || '';
    return (
      <div style={{
        minHeight: '100vh', background: '#F2F7FA', padding: 32,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}>
        <div style={{
          maxWidth: 820, margin: '40px auto', background: '#FFFFFF',
          border: '1px solid #E5E9EE', borderRadius: 12, padding: 28,
        }}>
          <div style={{ fontSize: 11, color: '#AA6E6E', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
            UI Crash
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 500, color: '#0F0F10', marginBottom: 6 }}>
            {err.name || 'Error'}: {err.message || 'Unknown error'}
          </h1>
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 20 }}>
            The app didn't crash — only this view. Reload to come back in.
          </p>
          <pre style={{
            background: '#0F0F10', color: '#E9FF5E', padding: 16, borderRadius: 8,
            fontSize: 11, lineHeight: 1.5, overflow: 'auto', maxHeight: 320,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {stack}
          </pre>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button
              onClick={this.reset}
              style={{
                padding: '8px 16px', fontSize: 13, borderRadius: 8,
                background: '#0F0F10', color: '#FFFFFF', border: 'none', cursor: 'pointer',
              }}>
              Try again
            </button>
            <button
              onClick={() => { window.location.href = '/'; }}
              style={{
                padding: '8px 16px', fontSize: 13, borderRadius: 8,
                background: 'transparent', color: '#0F0F10', border: '1px solid #D5D9DE', cursor: 'pointer',
              }}>
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
