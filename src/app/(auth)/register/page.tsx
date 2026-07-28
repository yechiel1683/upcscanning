import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Card } from '@/components/ui';
import { currentUser } from '@/server/auth/session';
import { AuthForm } from '../auth-form';

export const metadata: Metadata = { title: 'Create your account' };

export default async function RegisterPage() {
  if (await currentUser()) redirect('/dashboard');

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight text-fg">Create your account</h1>
      <p className="mt-1 mb-5 text-sm text-muted">
        50 free images to try it on a real supplier list.
      </p>
      <AuthForm mode="register" />
    </Card>
  );
}
