import { SetMetadata } from '@nestjs/common';

export const PRIVILEGES_KEY = 'requiredPrivileges';

/** FR-015: scoring, review and admin are distinct privileges. `@RequirePrivileges('score')` on a handler. */
export const RequirePrivileges = (...privileges: string[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(PRIVILEGES_KEY, privileges);
