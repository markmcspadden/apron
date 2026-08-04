import type { App } from 'firebase-admin/app';

export interface FirebaseAdminConfig {
  projectId?: string;
  serviceAccountPath?: string;
}

let appPromise: Promise<App | null> | null = null;

/**
 * Lazily initializes (or reuses) the shared firebase-admin App singleton.
 * Never rejects — resolves to `null` if firebase-admin isn't installed or
 * initialization otherwise fails, so callers can gracefully no-op instead
 * of crashing the process.
 *
 * The first caller's config wins; later calls just reuse the singleton via
 * `getApp()`, matching how firebase-admin itself expects a single default
 * app per process.
 */
export function getAdminApp(config?: FirebaseAdminConfig): Promise<App | null> {
  if (!appPromise) {
    appPromise = initAdminApp(config);
  }
  return appPromise;
}

async function initAdminApp(config?: FirebaseAdminConfig): Promise<App | null> {
  try {
    const { initializeApp, getApp, getApps, cert, applicationDefault } = await import('firebase-admin/app');

    const existing = getApps();
    if (existing.length > 0) {
      return getApp();
    }

    const projectId =
      config?.projectId ?? process.env['FIREBASE_PROJECT_ID'] ?? process.env['GOOGLE_CLOUD_PROJECT'];
    const serviceAccountPath =
      config?.serviceAccountPath ??
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ??
      process.env['FIREBASE_SERVICE_ACCOUNT'];

    // With a service account path, use explicit credentials. Otherwise fall
    // back to application default credentials, which auto-discover the
    // Cloud Run / GCE metadata server in deployed environments.
    const credential = serviceAccountPath ? cert(serviceAccountPath) : applicationDefault();

    return initializeApp({
      credential,
      ...(projectId ? { projectId } : {}),
    });
  } catch (err) {
    console.log('[firebase] firebase-admin not available:', (err as Error).message);
    return null;
  }
}
