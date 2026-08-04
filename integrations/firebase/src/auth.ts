import type { IncomingMessage } from 'node:http';
import type { App } from 'firebase-admin/app';
import { getAdminApp, type FirebaseAdminConfig } from './app.js';

export interface FirebaseAuthConfig {
  projectId?: string;
  serviceAccountPath?: string;
}

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  name?: string;
}

/** Thrown by requireAuth()/verifyToken() on a missing or invalid credential. */
export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export class FirebaseAuth {
  private app: App | null = null;
  private readonly appReady: Promise<App | null>;

  constructor(config?: FirebaseAuthConfig) {
    const adminConfig: FirebaseAdminConfig = {
      projectId: config?.projectId,
      serviceAccountPath: config?.serviceAccountPath,
    };

    this.appReady = getAdminApp(adminConfig).then(app => {
      this.app = app;
      return app;
    });
  }

  /** True once the firebase-admin app has finished initializing successfully. */
  isEnabled(): boolean {
    return this.app !== null;
  }

  /**
   * Verifies a Firebase ID token and returns the decoded user. Throws an
   * AuthError if auth isn't configured or the token is missing/invalid.
   */
  async verifyToken(token: string): Promise<AuthenticatedUser> {
    const app = this.app ?? (await this.appReady);
    if (!app) {
      throw new AuthError('Firebase auth is not configured', 503);
    }

    const { getAuth } = await import('firebase-admin/auth');

    let decoded;
    try {
      decoded = await getAuth(app).verifyIdToken(token);
    } catch (err) {
      throw new AuthError(`Invalid or expired token: ${(err as Error).message}`, 401);
    }

    return {
      uid: decoded.uid,
      email: decoded.email,
      name: (decoded['name'] as string | undefined) ?? undefined,
    };
  }

  /**
   * Extracts a Bearer token from the request's Authorization header,
   * verifies it, and returns the decoded user. Throws an AuthError
   * (with a 401-style `status`) if the header is missing/malformed or the
   * token doesn't verify.
   */
  async requireAuth(req: IncomingMessage): Promise<AuthenticatedUser> {
    const header = req.headers.authorization;
    if (!header || Array.isArray(header)) {
      throw new AuthError('Missing Authorization header', 401);
    }

    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) {
      throw new AuthError('Authorization header must use the Bearer scheme', 401);
    }

    const token = header.slice(prefix.length).trim();
    if (!token) {
      throw new AuthError('Missing bearer token', 401);
    }

    return this.verifyToken(token);
  }
}
