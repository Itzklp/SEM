import type { AppConfig } from '@fraudguard/config';
import type { LoginResponse } from '@fraudguard/contracts';
import { UserRepository } from '@fraudguard/persistence';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

import { APP_CONFIG } from '../common/config.provider';
import { USER_REPOSITORY } from '../common/persistence.provider';

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.users.findByEmail(email.toLowerCase());
    const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false;

    // Compare against a password hash either way, so a nonexistent email
    // and a wrong password take the same amount of time to reject.
    if (!user || !passwordMatches) {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Incorrect email or password',
      });
    }

    const ttlSeconds = this.config.security.jwt.ttlSeconds;
    const token = jwt.sign({ privileges: user.privileges }, this.config.security.jwt.secret, {
      subject: user.id,
      issuer: this.config.security.jwt.issuer,
      audience: this.config.security.jwt.audience,
      algorithm: 'HS256',
      expiresIn: ttlSeconds,
    });

    return {
      token,
      expiresInSeconds: ttlSeconds,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        privileges: [...user.privileges],
      },
    };
  }
}
