'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button, Field, inputClass } from '@/components/ui';
import { CodeInput } from './code-input';

/**
 * Signing up in two steps: details, then the code from the email.
 *
 * The details are kept in component state across the step change rather than
 * posted and stored server-side, so going back to fix a typo in the address
 * does not mean typing the password again. Nothing exists on the server until
 * the code is confirmed.
 */
export function SignupForm() {
  const router = useRouter();
  const [step, setStep] = useState<'details' | 'code'>('details');
  const [details, setDetails] = useState({ email: '', password: '', name: '' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [expiresIn, setExpiresIn] = useState(10);
  const [resendIn, setResendIn] = useState(0);

  // A resend button available instantly gets pressed three times before the
  // first email lands, and each press costs a send.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function sendCode(payload: typeof details, isResend = false) {
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/auth/signup/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: payload.email,
          password: payload.password,
          name: payload.name || undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        expiresInMinutes?: number;
      };

      if (!response.ok) {
        setError(data.error ?? 'Something went wrong. Try again.');
        return false;
      }

      if (data.expiresInMinutes) setExpiresIn(data.expiresInMinutes);
      setResendIn(30);
      if (isResend) setNotice('A new code is on its way.');
      return true;
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      return false;
    } finally {
      setPending(false);
    }
  }

  async function onDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = {
      email: String(form.get('email') ?? '').trim(),
      password: String(form.get('password') ?? ''),
      name: String(form.get('name') ?? '').trim(),
    };
    setDetails(next);
    if (await sendCode(next)) {
      setCode('');
      setStep('code');
    }
  }

  async function confirm(submitted: string) {
    if (submitted.length < 6 || pending) return;
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const response = await fetch('/api/auth/signup/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: details.email, code: submitted }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        setError(data.error ?? 'That code is not right.');
        setCode('');
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

  if (step === 'code') {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-fg">Check your email</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            We sent a six-digit code to{' '}
            <span className="font-medium text-fg">{details.email}</span>. It expires in{' '}
            {expiresIn} minutes.
          </p>
        </div>

        <CodeInput
          value={code}
          onChange={(next) => {
            setCode(next);
            if (error) setError(null);
          }}
          onComplete={(full) => void confirm(full)}
          disabled={pending}
          invalid={Boolean(error)}
        />

        {error ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {notice && !error ? (
          <p className="rounded-lg bg-positive-soft px-3 py-2 text-sm text-positive">{notice}</p>
        ) : null}

        <Button
          className="w-full"
          disabled={pending || code.length < 6}
          onClick={() => void confirm(code)}
        >
          {pending ? 'Checking…' : 'Confirm and create account'}
        </Button>

        <div className="space-y-2 text-center text-sm">
          <p className="text-muted">
            {resendIn > 0 ? (
              <span className="text-subtle">You can send another code in {resendIn}s</span>
            ) : (
              <button
                type="button"
                className="font-medium text-accent hover:underline"
                onClick={() => void sendCode(details, true)}
                disabled={pending}
              >
                Send another code
              </button>
            )}
          </p>
          <p>
            <button
              type="button"
              className="text-muted hover:text-fg"
              onClick={() => {
                setStep('details');
                setError(null);
                setNotice(null);
              }}
            >
              Use a different email
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onDetails} className="space-y-4" noValidate>
      <div className="mb-1">
        <h1 className="text-lg font-semibold tracking-tight text-fg">Create your account</h1>
        <p className="mt-1 text-sm text-muted">
          50 free images to try it on a real supplier list.
        </p>
      </div>

      <Field label="Name" htmlFor="name" hint="Optional — how we address you in the app.">
        <input
          id="name"
          name="name"
          autoComplete="name"
          defaultValue={details.name}
          className={inputClass}
        />
      </Field>

      <Field label="Work email" htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={details.email}
          className={inputClass}
          placeholder="you@company.com"
        />
      </Field>

      <Field label="Password" htmlFor="password" hint="At least 10 characters.">
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          defaultValue={details.password}
          className={inputClass}
        />
      </Field>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Sending a code…' : 'Continue'}
      </Button>

      <p className="text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-accent hover:text-accent">
          Sign in
        </Link>
      </p>
    </form>
  );
}
