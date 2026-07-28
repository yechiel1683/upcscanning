'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Field, inputClass } from '@/components/ui';

/** Shared sign-in / sign-up form. Both endpoints return the same shape. */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isRegister = mode === 'register';

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const payload = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      ...(isRegister ? { name: String(form.get('name') ?? '') || undefined } : {}),
    };

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? 'Something went wrong. Try again.');
        setPending(false);
        return;
      }

      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {isRegister ? (
        <Field label="Name" htmlFor="name" hint="Optional — how we address you in the app.">
          <input id="name" name="name" autoComplete="name" className={inputClass} />
        </Field>
      ) : null}

      <Field label="Work email" htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className={inputClass}
          placeholder="you@company.com"
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        hint={isRegister ? 'At least 10 characters.' : undefined}
      >
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={isRegister ? 10 : 1}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          className={inputClass}
        />
      </Field>

      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Just a moment…' : isRegister ? 'Create account' : 'Sign in'}
      </Button>

      <p className="text-center text-sm text-muted">
        {isRegister ? 'Already have an account? ' : "Don't have an account? "}
        <Link
          href={isRegister ? '/login' : '/register'}
          className="font-medium text-accent hover:text-accent"
        >
          {isRegister ? 'Sign in' : 'Start free'}
        </Link>
      </p>
    </form>
  );
}
