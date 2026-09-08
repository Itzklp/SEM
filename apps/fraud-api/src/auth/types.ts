/** The decoded, verified token identity attached to a request by `JwtAuthGuard`. FR-015. */
export interface AuthContext {
  /** Client identifier — the `sub` claim. Used as `reviewerId`-equivalent attribution wherever an action needs an actor (ASM-006). */
  readonly clientId: string;
  /** e.g. ['score'], ['review'], ['admin'] — checked by `PrivilegesGuard`/`RequirePrivileges`. */
  readonly privileges: readonly string[];
}

/** Module augmentation: every guarded route sees `request.auth` populated. */
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
