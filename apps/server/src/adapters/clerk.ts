import { createClerkClient, verifyToken } from '@clerk/backend';
import { AppError } from '../errors';
import type { Env, ExternalIdentity, ExternalIdentityVerifier } from '../types';

export class ClerkIdentityVerifier implements ExternalIdentityVerifier {
  constructor(
    private env: Env,
    private authorizedParty: string,
  ) {}
  async verifySessionToken(token: string): Promise<ExternalIdentity> {
    if (!this.env.CLERK_JWT_KEY) throw new AppError(503, 'CLERK_NOT_CONFIGURED', 'internalError');
    let payload: { sub?: string; sid?: string; iat?: number };
    try {
      payload = await verifyToken(token, {
        jwtKey: this.env.CLERK_JWT_KEY,
        authorizedParties: [this.authorizedParty],
      });
    } catch {
      throw new AppError(401, 'INVALID_CLERK_TOKEN', 'unauthorized');
    }
    if (!payload.sub || !payload.sid)
      throw new AppError(401, 'INVALID_CLERK_TOKEN', 'unauthorized');
    return {
      subject: payload.sub,
      sessionId: payload.sid,
      issuedAt: typeof payload.iat === 'number' ? payload.iat : 0,
    };
  }
  async fetchProfile(subject: string): Promise<{ email: string | null }> {
    if (this.env.CLERK_TEST_MODE === '1') return { email: subject + '@example.test' };
    if (!this.env.CLERK_SECRET_KEY)
      throw new AppError(503, 'CLERK_NOT_CONFIGURED', 'internalError');
    const user = await createClerkClient({ secretKey: this.env.CLERK_SECRET_KEY }).users.getUser(
      subject,
    );
    return { email: user.primaryEmailAddress?.emailAddress ?? null };
  }
}
