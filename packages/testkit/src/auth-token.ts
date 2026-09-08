import jwt from 'jsonwebtoken';

export interface SignTestTokenOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly clientId?: string;
  readonly privileges?: readonly string[];
  readonly expiresInSeconds?: number;
}

/**
 * Signs a JWT matching exactly what `JwtAuthGuard` (apps/fraud-api) expects
 * — same claim shape, same algorithm. Lives in testkit rather than being
 * duplicated in every test file that needs an authenticated request.
 */
export function signTestToken(options: SignTestTokenOptions): string {
  const {
    secret,
    issuer,
    audience,
    clientId = 'test-client',
    privileges = ['score'],
    expiresInSeconds = 3600,
  } = options;

  return jwt.sign({ privileges }, secret, {
    subject: clientId,
    issuer,
    audience,
    algorithm: 'HS256',
    expiresIn: expiresInSeconds,
  });
}
