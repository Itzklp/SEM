/**
 * Identical to apps/fraud-api/src/auth/types.ts — duplicated rather than
 * extracted into a shared package, a deliberate, scoped choice for this
 * phase (see jwt-auth.guard.ts's doc comment). The decoded, verified
 * token identity attached to a request by `JwtAuthGuard`. FR-015.
 */
export interface AuthContext {
  readonly clientId: string;
  readonly privileges: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
