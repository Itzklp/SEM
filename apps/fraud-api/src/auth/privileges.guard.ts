import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { PRIVILEGES_KEY } from './privileges.decorator';

/**
 * FR-015. Runs after `JwtAuthGuard` (Nest applies guards in registration
 * order) — `request.auth` is assumed populated. A caller authenticated
 * with the wrong privilege gets 403, not 401: they proved who they are,
 * they just aren't allowed to do this.
 */
@Injectable()
export class PrivilegesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string[] | undefined>(PRIVILEGES_KEY, context.getHandler());
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const granted = request.auth?.privileges ?? [];
    const hasAll = required.every((p) => granted.includes(p));

    if (!hasAll) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_PRIVILEGE',
        message: `Requires privilege(s): ${required.join(', ')}`,
      });
    }
    return true;
  }
}
