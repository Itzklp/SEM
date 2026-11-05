import type { AppConfig } from '@fraudguard/config';
import type { SystemHealthDto } from '@fraudguard/contracts';
import type { PersistenceContext } from '@fraudguard/persistence';
import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePrivileges } from '../auth/privileges.decorator';
import { PrivilegesGuard } from '../auth/privileges.guard';
import { APP_CONFIG } from '../common/config.provider';
import { PERSISTENCE_CONTEXT } from '../common/persistence.provider';

interface ComponentHealth {
  readonly status: 'up' | 'down';
  readonly latencyMs: number | null;
}

/** Admin-only dashboard view (FR-013's data, fanned out for a human instead of a scraper). Each service already answers its own /health — this just collects them in one round trip. */
@Controller('api/v1/admin/system-health')
@UseGuards(JwtAuthGuard, PrivilegesGuard)
export class SystemHealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PERSISTENCE_CONTEXT) private readonly persistence: PersistenceContext,
  ) {}

  @Get()
  @RequirePrivileges('admin')
  async check(): Promise<SystemHealthDto> {
    const [postgres, fraudApi, mlService] = await Promise.all([
      this.checkPostgres(),
      this.checkHttp(`http://localhost:${this.config.ports.fraudApi}/api/v1/health`),
      this.checkHttp(`${this.config.scoring.mlServiceUrl}/health/ready`),
    ]);

    // fraud-api's own health response already pinged Redis — reuse that
    // reading instead of giving review-api a Redis client it otherwise
    // has no reason to hold (ADR-004: this app is Postgres-only).
    const redis = await this.checkRedisViaFraudApi();

    return {
      checkedAt: new Date().toISOString(),
      components: {
        'fraud-api': fraudApi,
        'review-api': { status: 'up', latencyMs: 0 },
        'ml-service': mlService,
        postgres,
        redis,
      },
    };
  }

  private async checkPostgres(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      await this.persistence.coldPool.query('SELECT 1');
      return { status: 'up', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down', latencyMs: null };
    }
  }

  private async checkHttp(url: string): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { status: response.ok ? 'up' : 'down', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down', latencyMs: null };
    }
  }

  private async checkRedisViaFraudApi(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const response = await fetch(`http://localhost:${this.config.ports.fraudApi}/api/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      const body = (await response.json()) as {
        dependencies?: { redis?: { status?: string } };
      };
      const status = body.dependencies?.redis?.status === 'up' ? 'up' : 'down';
      return { status, latencyMs: Date.now() - start };
    } catch {
      return { status: 'down', latencyMs: null };
    }
  }
}
