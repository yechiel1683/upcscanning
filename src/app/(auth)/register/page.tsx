import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card } from '@/components/ui';
import { currentUser } from '@/server/auth/session';
import { SetupBanner } from '@/components/setup-banner';
import { AuthForm } from '../auth-form';

export const metadata: Metadata = { title: 'Create your account' };

export default async function RegisterPage() {
  if (await currentUser()) redirect('/dashboard');

  return (
    <>
      <SetupBanner />
      <Card className="p-6">
        <h1 className="text-lg font-semibold tracking-tight text-fg">Create your account</h1>
        <p className="mt-1 mb-5 text-sm text-muted">
          50 free images to try it on a real supplier list.
        </p>
        <AuthForm mode="register" />
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
