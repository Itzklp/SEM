import {
  deterministicEventId,
  modelUpdatedEvent,
  modelVersionSchema,
  type ModelVersionDto,
} from '@fraudguard/contracts';
import { captureTraceparent, currentTraceId } from '@fraudguard/observability';
import type { ModelRegistryRepository } from '@fraudguard/persistence';
import { Controller, Get, Inject, Post, Body, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePrivileges } from '../auth/privileges.decorator';
import { PrivilegesGuard } from '../auth/privileges.guard';
import { MODEL_REGISTRY_REPOSITORY } from '../common/persistence.provider';

/** FR-012/FR-014: cold-path model registry — any authenticated client can list, only 'admin' can register. */
@Controller('api/v1/models')
@UseGuards(JwtAuthGuard, PrivilegesGuard)
export class ModelsController {
  constructor(
    @Inject(MODEL_REGISTRY_REPOSITORY) private readonly repository: ModelRegistryRepository,
  ) {}

  @Get()
  async list(): Promise<ModelVersionDto[]> {
    // repository.list() runs a raw query, so registeredAt comes back as Postgres's
    // timestamptz text, not a Date — re-parse it before the strict ISO-8601 schema check.
    return (await this.repository.list()).map((entry) =>
      modelVersionSchema.parse({
        ...entry,
        registeredAt: new Date(entry['registeredAt'] as string | number | Date).toISOString(),
      }),
    );
  }

  @Post()
  @RequirePrivileges('admin')
  async register(@Body() body: unknown): Promise<ModelVersionDto> {
    const model = modelVersionSchema.parse(body);
    const envelope = modelUpdatedEvent.parse({
      eventId: deterministicEventId(model.modelVersion, 'model.updated'),
      eventType: 'model.updated',
      aggregateId: model.modelVersion,
      occurredAt: model.registeredAt,
      traceId: currentTraceId() ?? model.modelVersion,
      payload: {
        modelVersion: model.modelVersion,
        providerName: model.providerName,
        active: model.active,
        metrics: model.metrics,
      },
    });
    await this.repository.register({
      ...model,
      registeredAt: new Date(model.registeredAt),
      eventId: envelope.eventId,
      payload: envelope,
      traceContext: captureTraceparent() ?? null,
    });
    return model;
  }
}
