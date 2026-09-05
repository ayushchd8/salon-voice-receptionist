import { useState, type FormEvent } from 'react';
import { useLogin } from '../api/hooks';
import { ErrorNote, Field } from '../components/ui';

export function Login() {
  const [apiKey, setApiKey] = useState('');
  const login = useLogin();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate(apiKey.trim());
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Salon CRM</h1>
        <p className="page-sub">Sign in with your staff API key.</p>
        <ErrorNote error={login.error} />
        <Field label="Staff API key">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk_staff_…"
            autoFocus
            autoComplete="off"
          />
        </Field>
        <button className="primary" type="submit" disabled={!apiKey.trim() || login.isPending} style={{ width: '100%' }}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
          The key is exchanged for an httpOnly session cookie — it is never kept in browser storage.
          Run <code>pnpm seed</code> to print the demo keys.
        </p>
      </form>
    </div>
  );
}
