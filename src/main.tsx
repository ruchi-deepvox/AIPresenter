import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 600 }}>
          <h1 style={{ color: '#dc2626' }}>Something went wrong</h1>
          <pre style={{ background: '#fef2f2', padding: 16, overflow: 'auto', fontSize: 13 }}>
            {this.state.error.message}
          </pre>
          <p style={{ color: '#666' }}>Check the browser console for more details.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) {
  document.body.innerHTML = '<pre style="padding:24px;font-family:sans-serif">Error: #root element not found</pre>';
} else {
  try {
    createRoot(root).render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    );
  } catch (err) {
    root.innerHTML = `<pre style="padding:24px;font-family:sans-serif;color:#dc2626">Failed to render: ${err instanceof Error ? err.message : String(err)}</pre>`;
  }
}
