import { SetMetadata } from '@nestjs/common';

export const PRIVILEGES_KEY = 'requiredPrivileges';

/** FR-015: `@RequirePrivileges('review')` on a handler. Identical to fraud-api's — see jwt-auth.guard.ts's doc comment on why this is duplicated, not shared. */
export const RequirePrivileges = (...privileges: string[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(PRIVILEGES_KEY, privileges);
