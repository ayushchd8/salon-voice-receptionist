import { useEffect, type ReactNode } from 'react';
import { ApiRequestError } from '../api/client';

/** Field-level errors from a failed write, keyed by path, for inline display. */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  return error instanceof ApiRequestError ? error.fieldErrors : {};
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const api = error instanceof ApiRequestError ? error : null;
  const fields = api?.fieldErrors ?? {};

  return (
    <div className="alert error">
      <strong>{api?.message ?? (error as Error).message ?? 'Something went wrong.'}</strong>
      {api && <span className="small"> <code>{api.code}</code></span>}
      {Object.keys(fields).length > 0 && (
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {Object.entries(fields).map(([path, message]) => (
            <li key={path}>
              <code>{path}</code>: {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="empty">Loading {what}…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function money(amount: string, currency: string): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
  return `${symbols[currency] ?? `${currency} `}${amount}`;
}
