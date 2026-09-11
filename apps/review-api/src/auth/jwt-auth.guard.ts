import type { AppConfig } from '@fraudguard/config';
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import * as jwt from 'jsonwebtoken';

import { APP_CONFIG } from '../common/config.provider';

import type { AuthContext } from './types';

const BEARER_PREFIX = 'Bearer ';

/**
 * Byte-for-byte the same guard as `apps/fraud-api/src/auth/jwt-auth.guard
 * .ts` — duplicated, not shared, for this phase. `review-api` and
 * `fraud-api` are separate deployables (ADR-004's bulkhead) with no
 * shared runtime code today; extracting a `packages/auth` for ~80 lines
 * used by exactly two apps is real effort with no present payoff. A third
 * app needing this (or a real divergence between the two copies) is the
 * signal to extract it, not this phase's timeline on its own.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException({
        code: 'AUTH_MISSING_TOKEN',
        message: 'Missing or malformed Authorization header',
      });
    }

    const token = header.slice(BEARER_PREFIX.length);

    let payload: jwt.JwtPayload;
    try {
      const verified = jwt.verify(token, this.config.security.jwt.secret, {
        issuer: this.config.security.jwt.issuer,
        audience: this.config.security.jwt.audience,
        algorithms: ['HS256'],
      });
      if (typeof verified === 'string') {
        throw new Error('unexpected string payload');
      }
      payload = verified;
    } catch {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_TOKEN',
        message: 'Invalid or expired token',
      });
    }

    if (typeof payload.sub !== 'string' || !Array.isArray(payload['privileges'])) {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_CLAIMS',
        message: 'Token is missing required claims',
      });
    }

    const auth: AuthContext = {
      clientId: payload.sub,
      privileges: payload['privileges'] as string[],
    };
    request.auth = auth;
    return true;
  }
}
