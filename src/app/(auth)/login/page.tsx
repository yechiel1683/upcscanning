import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card } from '@/components/ui';
import { currentUser } from '@/server/auth/session';
import { SetupBanner } from '@/components/setup-banner';
import { AuthForm } from '../auth-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await currentUser()) redirect('/dashboard');

  return (
    <>
      <SetupBanner />
      <Card className="p-6">
        <h1 className="text-lg font-semibold tracking-tight text-fg">Sign in</h1>
        <p className="mt-1 mb-5 text-sm text-muted">
          Pick up where your last upload left off.
        </p>
        <AuthForm mode="login" />
      </Card>

      <p className="mt-4 text-center text-sm text-muted">
        Just want to see it work?{' '}
        <Link href="/try" className="font-medium text-accent hover:text-accent-hover">
          Try it without an account
        </Link>
      </p>
    </>
  );
}
