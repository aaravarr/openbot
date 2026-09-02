import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { useApp, type Toast as ToastModel } from "../store";

function ToastIcon({ kind }: { kind: ToastModel["kind"] }) {
  if (kind === "success") return <CheckCircle2 aria-hidden="true" />;
  if (kind === "error") return <TriangleAlert aria-hidden="true" />;
  return <Info aria-hidden="true" />;
}

export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div className={`toast toast--${t.kind}`} role="status" key={t.id}>
          <span className="toast__icon">
            <ToastIcon kind={t.kind} />
          </span>
          <div className="toast__body">
            <div className="toast__title">{t.title}</div>
            {t.message ? <div className="toast__msg">{t.message}</div> : null}
          </div>
          <button className="icon-btn toast__close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
