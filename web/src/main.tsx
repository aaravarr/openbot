import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("OpenBot: missing root");
}

/**
 * Failsafe for async errors that never reach a component (unhandled promise
 * rejections, uncaught exceptions). React keeps rendering, so a plain console
 * log is enough to avoid a silent failure; we surface a minimal DOM toast so a
 * background failure is still visible without depending on the React tree.
 */
function installGlobalErrorHandlers(): void {
  const showFatalToast = (message: string): void => {
    let stack = document.querySelector<HTMLElement>(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    const el = document.createElement("div");
    el.className = "toast toast--error";
    el.setAttribute("role", "status");
    el.innerHTML =
      '<span class="toast__icon"></span>' +
      '<div class="toast__body"><div class="toast__title">Unexpected error</div>' +
      '<div class="toast__msg"></div></div>';
    const msg = el.querySelector(".toast__msg");
    if (msg) msg.textContent = message;
    stack.appendChild(el);
    window.setTimeout(() => el.remove(), 6000);
  };

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? "Unhandled rejection");
    console.error("OpenBot: unhandled promise rejection:", reason);
    showFatalToast(message);
  });

  window.addEventListener("error", (event) => {
    const message = event.error instanceof Error ? event.error.message : event.message;
    console.error("OpenBot: uncaught error:", event.error ?? event.message);
    showFatalToast(message || "Uncaught error");
  });
}

installGlobalErrorHandlers();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
