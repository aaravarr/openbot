import { Component, type ErrorInfo, type ReactNode } from "react";
import { ShieldAlert, RotateCcw } from "lucide-react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Catches any uncaught render/lifecycle error and shows a friendly recovery
 * screen instead of a white page. The store and async handlers handle their own
 * errors (toasts), so reaching this boundary is the last line of defense.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("OpenBot UI crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main id="main" className="main" tabIndex={-1}>
          <div className="unreachable">
            <span className="unreachable__tile">
              <ShieldAlert aria-hidden="true" />
            </span>
            <h1>Something went wrong</h1>
            <p>The interface hit an unexpected error. Your providers, models, and keys are safe on the Computer.</p>
            <span className="mono">{this.state.error.message || this.state.error.name}</span>
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => window.location.reload()}
            >
              <RotateCcw aria-hidden="true" />
              Reload
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
