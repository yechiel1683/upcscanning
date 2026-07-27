import { ok, withUser } from '@/server/api/respond';

export const GET = withUser(async (user) => ok({ user }));
