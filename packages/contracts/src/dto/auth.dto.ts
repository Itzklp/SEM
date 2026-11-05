import { z } from 'zod';

/** `POST /api/v1/auth/login`. */
export const loginRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const USER_ROLES = ['customer', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const sessionUserSchema = z
  .object({
    id: z.string(),
    email: z.string().email(),
    displayName: z.string(),
    role: z.enum(USER_ROLES),
    privileges: z.array(z.string()),
  })
  .strict();

export type SessionUser = z.infer<typeof sessionUserSchema>;

export const loginResponseSchema = z
  .object({
    token: z.string(),
    expiresInSeconds: z.number().int().positive(),
    user: sessionUserSchema,
  })
  .strict();

export type LoginResponse = z.infer<typeof loginResponseSchema>;
