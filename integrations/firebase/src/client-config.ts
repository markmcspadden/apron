export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

/**
 * Returns the Firebase client-side config sourced from env vars, for the
 * board UI to bootstrap client-side Firebase Auth. Returns null if the
 * required env vars aren't all set (client-side auth is disabled).
 */
export function getClientConfig(): FirebaseClientConfig | null {
  const apiKey = process.env['FIREBASE_API_KEY'];
  const authDomain = process.env['FIREBASE_AUTH_DOMAIN'];
  const projectId = process.env['FIREBASE_PROJECT_ID'];

  if (!apiKey || !authDomain || !projectId) {
    return null;
  }

  return { apiKey, authDomain, projectId };
}
