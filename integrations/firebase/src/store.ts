import type { Firestore } from 'firebase-admin/firestore';
import { getAdminApp, type FirebaseAdminConfig } from './app.js';

export interface FirestoreStoreConfig {
  projectId?: string;
}

export class FirestoreStore {
  private db: Firestore | null = null;
  private readonly dbReady: Promise<Firestore | null>;

  constructor(config?: FirestoreStoreConfig) {
    const adminConfig: FirebaseAdminConfig = { projectId: config?.projectId };

    this.dbReady = getAdminApp(adminConfig)
      .then(async app => {
        if (!app) return null;
        const { getFirestore } = await import('firebase-admin/firestore');
        return getFirestore(app);
      })
      .catch(err => {
        console.log('[firebase] Firestore not available:', (err as Error).message);
        return null;
      })
      .then(db => {
        this.db = db;
        return db;
      });
  }

  /** True once Firestore has finished initializing successfully. */
  isEnabled(): boolean {
    return this.db !== null;
  }

  private async ready(): Promise<Firestore | null> {
    return this.db ?? this.dbReady;
  }

  async saveShow(showId: string, data: Record<string, unknown>): Promise<void> {
    const db = await this.ready();
    if (!db) return;
    await db.collection('shows').doc(showId).set(data, { merge: true });
  }

  async getShow(showId: string): Promise<Record<string, unknown> | undefined> {
    const db = await this.ready();
    if (!db) return undefined;
    const snap = await db.collection('shows').doc(showId).get();
    return snap.exists ? snap.data() : undefined;
  }

  async saveDecision(showId: string, decision: Record<string, unknown>): Promise<string | undefined> {
    const db = await this.ready();
    if (!db) return undefined;

    const { FieldValue } = await import('firebase-admin/firestore');
    const ref = await db
      .collection('shows')
      .doc(showId)
      .collection('decisions')
      .add({ ...decision, timestamp: FieldValue.serverTimestamp() });

    return ref.id;
  }

  async getDecisions(showId: string): Promise<Record<string, unknown>[]> {
    const db = await this.ready();
    if (!db) return [];

    const snap = await db
      .collection('shows')
      .doc(showId)
      .collection('decisions')
      .orderBy('timestamp', 'desc')
      .get();

    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  async recordAuditEvent(event: Record<string, unknown>): Promise<string | undefined> {
    const db = await this.ready();
    if (!db) return undefined;

    const { FieldValue } = await import('firebase-admin/firestore');
    const ref = await db.collection('audit_events').add({
      ...event,
      timestamp: FieldValue.serverTimestamp(),
    });

    return ref.id;
  }

  async getAuditEvents(showId: string, limit = 100): Promise<Record<string, unknown>[]> {
    const db = await this.ready();
    if (!db) return [];

    const snap = await db
      .collection('audit_events')
      .where('showId', '==', showId)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }
}
