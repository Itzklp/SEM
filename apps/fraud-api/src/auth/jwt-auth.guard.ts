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
 * FR-015. Every route this guards requires a valid, non-expired JWT
 * bearer token. On success, `request.auth` is populated for downstream
 * guards/handlers (`PrivilegesGuard`, `reviewerId` attribution).
 *
 * Deliberately hand-rolled rather than @nestjs/passport — one verification
 * call against `jsonwebtoken`, no strategy abstraction needed for a single
 * auth scheme. Threat model ST-001..004 (threat-model.md §6) is what this
 * guard exists to satisfy: absent, malformed, expired and forged tokens
 * must all be rejected.
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
      // Deliberately one generic message for every failure mode (expired,
      // malformed, wrong signature, wrong issuer/audience) — distinguishing
      // them in the response would hand an attacker a probing oracle.
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
