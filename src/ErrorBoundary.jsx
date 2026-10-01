import { Component } from 'react';

// Keeps one page's crash from blanking the whole portal: the sidebar stays,
// and the page area explains what happened with a way to retry.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Page crashed:', error, info.componentStack);
  }

  componentDidUpdate(prev) {
    // Moving to another page clears the error.
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel crash">
        <div className="panel__title">This page couldn’t be shown</div>
        <p className="muted" style={{ margin: '0 0 16px' }}>
          Something went wrong while drawing it. Reloading usually fixes this; if it keeps happening, the portal’s
          server may need restarting after an update.
        </p>
        <p className="small muted mono" style={{ margin: '0 0 18px' }}>{String(this.state.error.message || this.state.error)}</p>
        <div className="form-row">
          <button className="btn btn--primary" onClick={() => window.location.reload()}>Reload</button>
          <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
