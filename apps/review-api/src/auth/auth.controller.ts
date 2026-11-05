import { loginRequestSchema, type LoginResponse } from '@fraudguard/contracts';
import { Body, Controller, HttpCode, HttpStatus, Post, UsePipes } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe';

import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(loginRequestSchema))
  async login(@Body() body: { email: string; password: string }): Promise<LoginResponse> {
    return this.authService.login(body.email, body.password);
  }
}
