// Toast — the `@civitai/components` markup contract, rendered in React.
//
// Until 0.9 a React `ToastProvider` + `useToast()` pair owned the queue;
// both were deleted with the hand-written layer, and the contract leaves
// the queue to the author. This provider is that queue: `show()` enqueues
// a toast card inside the `aria-live` region and auto-dismisses it.

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface ToastShowOptions {
  message: string;
  heading?: string;
  color?: 'info' | 'success' | 'warning' | 'error';
  /** Milliseconds. `0` or less makes it sticky. */
  duration?: number;
  urgent?: boolean;
}

export interface ToastApi {
  show: (options: ToastShowOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const DEFAULT_DURATION_MS = 4000;

interface ToastEntry extends ToastShowOptions {
  id: string;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const clear = useCallback(() => setToasts([]), []);

  const show = useCallback(
    (options: ToastShowOptions): string => {
      seq.current += 1;
      const id = `toast-${seq.current}`;
      setToasts((list) => [...list, { ...options, id }]);
      const duration = options.duration ?? DEFAULT_DURATION_MS;
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );

  const api: ToastApi = { show, dismiss, clear };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div data-civitai-ui="toast-region" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            data-civitai-ui="toast"
            role={t.urgent ? 'alert' : 'status'}
            {...(t.color ? { 'data-color': t.color } : {})}
          >
            <div data-civitai-ui-toast-body>
              {t.heading ? <div data-civitai-ui-toast-title>{t.heading}</div> : null}
              {t.message}
            </div>
            <button type="button" data-civitai-ui-toast-close aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
