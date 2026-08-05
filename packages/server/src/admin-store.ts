/**
 * Admin data store — wraps Firestore when available, falls back to in-memory Maps.
 *
 * The firebase-admin SDK is dynamically imported so this module works even when
 * Firebase is not configured. The in-memory fallback keeps the admin API fully
 * functional for development and demo scenarios.
 */

import { randomUUID } from 'node:crypto';
import type { FirestoreStore } from '@apron/integration-firebase';

// ---------------------------------------------------------------------------
// Minimal Firestore type surface — avoids a direct dependency on firebase-admin
// from the server package (pnpm strict hoisting).
// ---------------------------------------------------------------------------

interface FirestoreDb {
  collection(path: string): CollectionRef;
}

interface CollectionRef {
  doc(id: string): DocRef;
  get(): Promise<QuerySnap>;
}

interface DocRef {
  readonly id: string;
  collection(path: string): CollectionRef;
  set(data: Record<string, unknown>): Promise<unknown>;
  get(): Promise<DocSnap>;
  update(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}

interface DocSnap {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface QuerySnap {
  readonly docs: DocSnap[];
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  name: string;
  type?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Entity {
  id: string;
  accountId: string;
  type: 'tmc' | 'production';
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  accountId: string;
  entityId: string;
  role: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Game {
  id: string;
  accountId: string;
  network: string;
  title: string;
  venue: string;
  date: string;
  callTime?: string;
  crewCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrewRecord {
  id: string;
  accountId: string;
  name: string;
  position: string;
  department: string;
  homeMarket: string;
  tier?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Assignment {
  id: string;
  gameId: string;
  crewId: string;
  position?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Firestore document snapshot into a plain record with ISO timestamps. */
function docToRecord(doc: DocSnap): Record<string, unknown> {
  const data = doc.data() ?? {};
  const result: Record<string, unknown> = { id: doc.id };
  for (const [key, value] of Object.entries(data)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      'toDate' in (value as object) &&
      typeof (value as { toDate: unknown }).toDate === 'function'
    ) {
      result[key] = (value as { toDate(): Date }).toDate().toISOString();
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Dynamic module specifiers — using variables prevents TypeScript from
 * attempting static module resolution against firebase-admin, which is only
 * a transitive dependency of the server package under strict pnpm hoisting.
 */
const FIRESTORE_MOD = 'firebase-admin/firestore';
const APP_MOD = 'firebase-admin/app';

/** Get `FieldValue.serverTimestamp()` from the dynamically-imported SDK. */
async function serverTimestamp(): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  const { FieldValue } = await import(FIRESTORE_MOD);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  return FieldValue.serverTimestamp();
}

// ---------------------------------------------------------------------------
// AdminStore
// ---------------------------------------------------------------------------

export class AdminStore {
  private db: FirestoreDb | null = null;
  private readonly dbReady: Promise<FirestoreDb | null>;

  // In-memory fallback stores (nested Maps per account)
  private readonly memAccounts = new Map<string, Account>();
  private readonly memEntities = new Map<string, Map<string, Entity>>();
  private readonly memMembers = new Map<string, Map<string, Member>>();
  private readonly memGames = new Map<string, Map<string, Game>>();
  private readonly memCrew = new Map<string, Map<string, CrewRecord>>();
  // Assignments keyed by "accountId:gameId"
  private readonly memAssignments = new Map<string, Map<string, Assignment>>();

  constructor(firestoreStore: FirestoreStore | null) {
    if (firestoreStore && firestoreStore.isEnabled()) {
      this.dbReady = this.initFirestore();
    } else {
      this.dbReady = Promise.resolve(null);
    }
  }

  private async initFirestore(): Promise<FirestoreDb | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const { getFirestore } = await import(FIRESTORE_MOD);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const { getApp } = await import(APP_MOD);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const db = getFirestore(getApp()) as unknown as FirestoreDb;
      this.db = db;
      return db;
    } catch {
      return null;
    }
  }

  private async ready(): Promise<FirestoreDb | null> {
    return this.db ?? this.dbReady;
  }

  // -------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------

  async listAccounts(): Promise<Account[]> {
    const db = await this.ready();
    if (db) {
      const snap = await db.collection('accounts').get();
      return snap.docs.map(d => docToRecord(d)) as unknown as Account[];
    }
    return [...this.memAccounts.values()];
  }

  async createAccount(data: { name: string; type?: string }): Promise<Account> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const db = await this.ready();
    if (db) {
      const ts = await serverTimestamp();
      const record: Record<string, unknown> = {
        name: data.name,
        createdAt: ts,
        updatedAt: ts,
      };
      if (data.type != null) record['type'] = data.type;
      await db.collection('accounts').doc(id).set(record);
      return { id, name: data.name, type: data.type, createdAt: now, updatedAt: now };
    }

    const account: Account = {
      id,
      name: data.name,
      type: data.type,
      createdAt: now,
      updatedAt: now,
    };
    this.memAccounts.set(id, account);
    return account;
  }

  async getAccount(accountId: string): Promise<Account | null> {
    const db = await this.ready();
    if (db) {
      const doc = await db.collection('accounts').doc(accountId).get();
      return doc.exists ? (docToRecord(doc) as unknown as Account) : null;
    }
    return this.memAccounts.get(accountId) ?? null;
  }

  // -------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------

  async listEntities(accountId: string): Promise<Entity[]> {
    const db = await this.ready();
    if (db) {
      const snap = await db
        .collection('accounts')
        .doc(accountId)
        .collection('entities')
        .get();
      return snap.docs.map(d => docToRecord(d)) as unknown as Entity[];
    }
    return [...(this.memEntities.get(accountId)?.values() ?? [])];
  }

  async createEntity(
    accountId: string,
    data: { type: 'tmc' | 'production'; name: string },
  ): Promise<Entity> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const db = await this.ready();
    if (db) {
      const ts = await serverTimestamp();
      await db
        .collection('accounts')
        .doc(accountId)
        .collection('entities')
        .doc(id)
        .set({
          accountId,
          type: data.type,
          name: data.name,
          createdAt: ts,
          updatedAt: ts,
        });
      return { id, accountId, type: data.type, name: data.name, createdAt: now, updatedAt: now };
    }

    const entity: Entity = {
      id,
      accountId,
      type: data.type,
      name: data.name,
      createdAt: now,
      updatedAt: now,
    };
    if (!this.memEntities.has(accountId)) {
      this.memEntities.set(accountId, new Map());
    }
    this.memEntities.get(accountId)!.set(id, entity);
    return entity;
  }

  // -------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------

  async listMembers(accountId: string): Promise<Member[]> {
    const db = await this.ready();
    if (db) {
      const snap = await db
        .collection('accounts')
        .doc(accountId)
        .collection('members')
        .get();
      return snap.docs.map(d => docToRecord(d)) as unknown as Member[];
    }
    return [...(this.memMembers.get(accountId)?.values() ?? [])];
  }

  async createMember(
    accountId: string,
    data: { entityId: string; role: string; email: string; name: string },
  ): Promise<Member> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const db = await this.ready();
    if (db) {
      const ts = await serverTimestamp();
      await db
        .collection('accounts')
        .doc(accountId)
        .collection('members')
        .doc(id)
        .set({
          accountId,
          entityId: data.entityId,
          role: data.role,
          email: data.email,
          name: data.name,
          createdAt: ts,
          updatedAt: ts,
        });
      return { id, accountId, ...data, createdAt: now, updatedAt: now };
    }

    const member: Member = { id, accountId, ...data, createdAt: now, updatedAt: now };
    if (!this.memMembers.has(accountId)) {
      this.memMembers.set(accountId, new Map());
    }
    this.memMembers.get(accountId)!.set(id, member);
    return member;
  }

  async deleteMember(accountId: string, memberId: string): Promise<boolean> {
    const db = await this.ready();
    if (db) {
      const ref = db
        .collection('accounts')
        .doc(accountId)
        .collection('members')
        .doc(memberId);
      const doc = await ref.get();
      if (!doc.exists) return false;
      await ref.delete();
      return true;
    }

    const members = this.memMembers.get(accountId);
    if (!members?.has(memberId)) return false;
    members.delete(memberId);
    return true;
  }

  // -------------------------------------------------------------------
  // Games
  // -------------------------------------------------------------------

  async listGames(accountId: string): Promise<Game[]> {
    const db = await this.ready();
    if (db) {
      const snap = await db
        .collection('accounts')
        .doc(accountId)
        .collection('games')
        .get();
      return snap.docs.map(d => docToRecord(d)) as unknown as Game[];
    }
    return [...(this.memGames.get(accountId)?.values() ?? [])];
  }

  async createGame(
    accountId: string,
    data: {
      network: string;
      title: string;
      venue: string;
      date: string;
      callTime?: string;
      crewCount?: number;
    },
  ): Promise<Game> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const db = await this.ready();
    if (db) {
      const ts = await serverTimestamp();
      const record: Record<string, unknown> = {
        accountId,
        network: data.network,
        title: data.title,
        venue: data.venue,
        date: data.date,
        createdAt: ts,
        updatedAt: ts,
      };
      if (data.callTime != null) record['callTime'] = data.callTime;
      if (data.crewCount != null) record['crewCount'] = data.crewCount;
      await db.collection('accounts').doc(accountId).collection('games').doc(id).set(record);
      return { id, accountId, ...data, createdAt: now, updatedAt: now };
    }

    const game: Game = { id, accountId, ...data, createdAt: now, updatedAt: now };
    if (!this.memGames.has(accountId)) {
      this.memGames.set(accountId, new Map());
    }
    this.memGames.get(accountId)!.set(id, game);
    return game;
  }

  async getGame(accountId: string, gameId: string): Promise<Game | null> {
    const db = await this.ready();
    if (db) {
      const doc = await db
        .collection('accounts')
        .doc(accountId)
        .collection('games')
        .doc(gameId)
        .get();
      return doc.exists ? (docToRecord(doc) as unknown as Game) : null;
    }
    return this.memGames.get(accountId)?.get(gameId) ?? null;
  }

  async updateGame(
    accountId: string,
    gameId: string,
    data: Partial<Omit<Game, 'id' | 'accountId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Game | null> {
    const db = await this.ready();
    if (db) {
      const ref = db
        .collection('accounts')
        .doc(accountId)
        .collection('games')
        .doc(gameId);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const ts = await serverTimestamp();
      await ref.update({ ...data, updatedAt: ts });
      const updated = await ref.get();
      return docToRecord(updated) as unknown as Game;
    }

    const games = this.memGames.get(accountId);
    const existing = games?.get(gameId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated: Game = { ...existing, ...data, updatedAt: now };
    games!.set(gameId, updated);
    return updated;
  }

  // -------------------------------------------------------------------
  // Crew
  // -------------------------------------------------------------------

  async listCrew(accountId: string): Promise<CrewRecord[]> {
    const db = await this.ready();
    if (db) {
      const snap = await db
        .collection('accounts')
        .doc(accountId)
        .collection('crew')
        .get();
      return snap.docs.map(d => docToRecord(d)) as unknown as CrewRecord[];
    }
    return [...(this.memCrew.get(accountId)?.values() ?? [])];
  }

  async createCrew(
    accountId: string,
    data: {
      name: string;
      position: string;
      department: string;
      homeMarket: string;
      tier?: string;
    },
  ): Promise<CrewRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const db = await this.ready();
    if (db) {
      const ts = await serverTimestamp();
      const record: Record<string, unknown> = {
        accountId,
        name: data.name,
        position: data.position,
        department: data.department,
        homeMarket: data.homeMarket,
        createdAt: ts,
        updatedAt: ts,
      };
      if (data.tier != null) record['tier'] = data.tier;
      await db.collection('accounts').doc(accountId).collection('crew').doc(id).set(record);
      return { id, accountId, ...data, createdAt: now, updatedAt: now };
    }

    const crew: CrewRecord = { id, accountId, ...data, createdAt: now, updatedAt: now };
    if (!this.memCrew.has(accountId)) {
      this.memCrew.set(accountId, new Map());
    }
    this.memCrew.get(accountId)!.set(id, crew);
    return crew;
  }

  async getCrew(accountId: string, crewId: string): Promise<CrewRecord | null> {
    const db = await this.ready();
    if (db) {
      const doc = await db
        .collection('accounts')
        .doc(accountId)
        .collection('crew')
        .doc(crewId)
        .get();
      return doc.exists ? (docToRecord(doc) as unknown as CrewRecord) : null;
    }
    return this.memCrew.get(accountId)?.get(crewId) ?? null;
  }

  async updateCrew(
    accountId: string,
    crewId: string,
    data: Partial<Omit<CrewRecord, 'id' | 'accountId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<CrewRecord | null> {
    const db = await this.ready();
    if (db) {
      const ref = db
        .collection('accounts')
        .doc(accountId)
        .collection('crew')
        .doc(crewId);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const ts = await serverTimestamp();
      await ref.update({ ...data, updatedAt: ts });
      const updated = await ref.get();
      return docToRecord(updated) as unknown as CrewRecord;
    }

    const crewMap = this.memCrew.get(accountId);
    const existing = crewMap?.get(crewId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated: CrewRecord = { ...existing, ...data, updatedAt: now };
    crewMap!.set(crewId, updated);
    return updated;
  }

  // -------------------------------------------------------------------
  // Assignments
  // -------------------------------------------------------------------

  private assignmentKey(accountId: string, gameId: string): string {
    return `${accountId}:${gameId}`;
  }

  async listAssignments(accountId: string, gameId: string): Promise<Assignment[]> {
    const db = await this.ready();
    if (db) {
      const snap = await db
        .collection('accounts')
        .doc(accountId)
        .collection('games')
        .doc(gameId)
        .collection('assignments')
        .get();
      return snap.docs.map(d => docToRecord(d)) as unknown as Assignment[];
    }
    const key = this.assignmentKey(accountId, gameId);
    return [...(this.memAssignments.get(key)?.values() ?? [])];
  }

  async createAssignment(
    accountId: string,
    gameId: string,
    data: { crewId: string; position?: string; notes?: string },
  ): Promise<Assignment> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const db = await this.ready();
    if (db) {
      const ts = await serverTimestamp();
      const record: Record<string, unknown> = {
        gameId,
        crewId: data.crewId,
        createdAt: ts,
        updatedAt: ts,
      };
      if (data.position != null) record['position'] = data.position;
      if (data.notes != null) record['notes'] = data.notes;
      await db
        .collection('accounts')
        .doc(accountId)
        .collection('games')
        .doc(gameId)
        .collection('assignments')
        .doc(id)
        .set(record);
      return { id, gameId, ...data, createdAt: now, updatedAt: now };
    }

    const assignment: Assignment = { id, gameId, ...data, createdAt: now, updatedAt: now };
    const key = this.assignmentKey(accountId, gameId);
    if (!this.memAssignments.has(key)) {
      this.memAssignments.set(key, new Map());
    }
    this.memAssignments.get(key)!.set(id, assignment);
    return assignment;
  }

  async deleteAssignment(
    accountId: string,
    gameId: string,
    assignmentId: string,
  ): Promise<boolean> {
    const db = await this.ready();
    if (db) {
      const ref = db
        .collection('accounts')
        .doc(accountId)
        .collection('games')
        .doc(gameId)
        .collection('assignments')
        .doc(assignmentId);
      const doc = await ref.get();
      if (!doc.exists) return false;
      await ref.delete();
      return true;
    }

    const key = this.assignmentKey(accountId, gameId);
    const assignments = this.memAssignments.get(key);
    if (!assignments?.has(assignmentId)) return false;
    assignments.delete(assignmentId);
    return true;
  }
}
