import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { AuthService, JwtPayload } from './auth.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private authService: AuthService,
    config: NyabaseConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('auth.jwtSecret'),
    });
  }

  async validate(payload: JwtPayload) {
    return this.authService.validateJwtPayload(payload);
  }
}
