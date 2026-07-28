'use client';

import { useEffect, useState } from 'react';

import { Button, formatDate, inputClass } from '@/components/ui';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch('/api/api-keys', { cache: 'no-store' });
    if (!response.ok) return;
    const body = (await response.json()) as { apiKeys: ApiKey[] };
    setKeys(body.apiKeys);
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as { key?: string; error?: string };

      if (!response.ok || !body.key) {
        setError(body.error ?? 'Could not create that key.');
        return;
      }

      setCreated(body.key);
      setName('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await fetch('/api/api-keys', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await load();
  }

  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-muted">
        Use an API key to upload lists and pull results from your own systems. Pass it as{' '}
        <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
          Authorization: Bearer &lt;key&gt;
        </code>
        .
      </p>

      {created ? (
        <div className="rounded-lg border border-positive-soft bg-positive-soft/60 p-3">
          <p className="text-sm font-medium text-fg">Copy this key now — it is shown once.</p>
          <code className="mt-2 block overflow-x-auto rounded bg-surface px-3 py-2 font-mono text-xs text-fg">
            {created}
          </code>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="mt-2 text-xs font-medium text-muted hover:text-fg"
          >
            I have saved it
          </button>
        </div>
      ) : null}

      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Key name, e.g. Shopify sync"
          className={`${inputClass} max-w-xs flex-1`}
        />
        <Button type="submit" variant="secondary" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create key'}
        </Button>
      </form>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {keys === null ? (
        <div className="h-10 animate-pulse rounded bg-surface-2" />
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted">No API keys yet.</p>
      ) : (
        <ul className="divide-y divide-line-soft rounded-lg border border-line">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-fg">{key.name}</p>
                <p className="mt-0.5 font-mono text-xs text-muted">
                  {key.prefix}…
                  <span className="ml-2 font-sans">
                    created {formatDate(key.createdAt)}
                    {key.lastUsedAt ? ` · last used ${formatDate(key.lastUsedAt)}` : ' · never used'}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => void revoke(key.id)}
                className="text-sm font-medium text-danger hover:opacity-80"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
