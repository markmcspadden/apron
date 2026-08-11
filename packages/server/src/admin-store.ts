/**
 * Admin data store — wraps Firestore when available, falls back to in-memory Maps.
 *
 * The firebase-admin SDK is dynamically imported so this module works even when
 * Firebase is not configured. The in-memory fallback keeps the admin API fully
 * functional for development and demo scenarios.
 */

import { randomUUID } from 'node:crypto';
import type { FirestoreStore } from '@apron/integration-firebase';
import type { CrewGameAssignment } from '@apron/types';

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
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
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

export type GameType = 'baseball' | 'hockey' | 'football' | 'basketball' | 'soccer' | 'entertainment';

/** Default durations by sport/show type (minutes). */
export const GAME_TYPE_DEFAULTS: Record<GameType, { duration: number; strike: number }> = {
  baseball:      { duration: 180, strike: 75 },
  hockey:        { duration: 150, strike: 60 },
  football:      { duration: 210, strike: 90 },
  basketball:    { duration: 150, strike: 45 },
  soccer:        { duration: 120, strike: 45 },
  entertainment: { duration: 180, strike: 90 },
};

export interface Game {
  id: string;
  accountId: string;
  network: string;
  title: string;
  venue: string;
  date: string;
  callTime?: string;
  crewCount?: number;

  // ---- timing model ----
  gameType?: GameType;
  /** Game/show start time (HH:MM, 24h local). */
  startTime?: string;
  /** Override expected duration in minutes (otherwise uses gameType default). */
  expectedDuration?: number;
  /** Override expected end time (HH:MM). Takes precedence over startTime + duration. */
  expectedEndTime?: string;
  /** Strike / load-out duration in minutes (override; otherwise gameType default). */
  strikeDuration?: number;
  /** Drive from venue to transport hub in minutes. */
  venueToTransport?: number;
  /** Drive from transport hub to overnight location in minutes. */
  transportDuration?: number;
  /** Departure airport IATA code (e.g. 'CLE'). */
  departureAirport?: string;
  /** Label for overnight stop (e.g. 'Airport hotel', 'Team hotel'). */
  overnightLabel?: string;
  /** Lobby call time for next day (HH:MM, 24h local). */
  lobbyCallTime?: string;
  /** Minimum crew rest in hours (NABET default: 8). */
  minRestHours?: number;

  // ---- live monitoring ----
  /** ESPN event ID for live score monitoring (numeric string). */
  espnEventId?: string;

  /**
   * Lightweight agent status summary — uniform shape for every agent.
   * The game doc answers "which agents are running?" at a glance.
   * Agent-specific data lives in the `agents` subcollection.
   */
  agents?: Partial<Record<import('@apron/types').AgentName, AgentAssignment>>;

  createdAt: string;
  updatedAt: string;
}

/**
 * Uniform agent lifecycle on the game document — same three fields
 * regardless of whether it's SPOTTER, TRAFFIC, ADVANCE, etc.
 */
export interface AgentAssignment {
  status: 'active' | 'idle' | 'done';
  startedAt: string;
  stoppedAt?: string;
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

/** ISO timestamp for Firestore records — we use plain strings rather than
 *  FieldValue.serverTimestamp() because firebase-admin isn't directly
 *  resolvable from packages/server/ under pnpm strict hoisting. */
function serverTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Deep-strip `undefined` values from an object — Firestore rejects them.
 * Returns a new plain object safe for Firestore writes.
 */
function stripUndefined(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (value !== undefined) {
        result[key] = stripUndefined(value);
      }
    }
    return result;
  }
  return obj;
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
  // Crew game assignments keyed by "accountId:gameId" → Map<crewId, CrewGameAssignment>
  private readonly memCrewAssignments = new Map<string, Map<string, CrewGameAssignment>>();
  // Agent records keyed by "accountId:gameId" → Map<agentName, record>
  private readonly memAgentRecords = new Map<string, Map<string, Record<string, unknown>>>();

  constructor(firestoreStore: FirestoreStore | null) {
    if (firestoreStore) {
      // Get the Firestore db instance from FirestoreStore — we can't import
      // firebase-admin directly because pnpm strict hoisting makes it
      // unreachable from packages/server/.
      this.dbReady = firestoreStore.getDb().then(db => {
        if (db) {
          this.db = db as unknown as FirestoreDb;
        }
        return this.db;
      });
    } else {
      this.dbReady = Promise.resolve(null);
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

  async createAccount(data: { name: string; type?: string; id?: string }): Promise<Account> {
    const id = data.id ?? randomUUID();
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
    data: { type: 'tmc' | 'production'; name: string; id?: string },
  ): Promise<Entity> {
    const id = data.id ?? randomUUID();
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
    data: { entityId: string; role: string; email: string; name: string; id?: string },
  ): Promise<Member> {
    const id = data.id ?? randomUUID();
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
      id?: string;
      gameType?: GameType;
      startTime?: string;
      expectedDuration?: number;
      expectedEndTime?: string;
      strikeDuration?: number;
      venueToTransport?: number;
      transportDuration?: number;
      departureAirport?: string;
      overnightLabel?: string;
      lobbyCallTime?: string;
      minRestHours?: number;
      espnEventId?: string;
    },
  ): Promise<Game> {
    const id = data.id ?? randomUUID();
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
      // Optional fields — write to Firestore only if provided
      const optionalFields = [
        'callTime', 'crewCount', 'gameType', 'startTime', 'expectedDuration',
        'expectedEndTime', 'strikeDuration', 'venueToTransport', 'transportDuration',
        'departureAirport', 'overnightLabel', 'lobbyCallTime', 'minRestHours',
        'espnEventId',
      ] as const;
      for (const field of optionalFields) {
        if (data[field] != null) record[field] = data[field];
      }
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

  /**
   * Update a single agent's lifecycle status on the game document.
   * Uses Firestore dot-notation to avoid clobbering sibling agent entries.
   */
  async setAgentAssignment(
    accountId: string,
    gameId: string,
    agentName: import('@apron/types').AgentName,
    assignment: AgentAssignment,
  ): Promise<void> {
    const db = await this.ready();
    if (db) {
      const ref = db
        .collection('accounts').doc(accountId)
        .collection('games').doc(gameId);
      // Dot-notation update: `agents.SPOTTER` won't overwrite `agents.TRAFFIC`
      await ref.update({
        [`agents.${agentName}`]: assignment,
        updatedAt: serverTimestamp(),
      });
      return;
    }
    // In-memory fallback
    const games = this.memGames.get(accountId);
    const existing = games?.get(gameId);
    if (existing) {
      existing.agents = { ...existing.agents, [agentName]: assignment };
      existing.updatedAt = new Date().toISOString();
    }
  }

  async deleteGame(accountId: string, gameId: string): Promise<boolean> {
    const db = await this.ready();
    if (db) {
      const ref = db
        .collection('accounts')
        .doc(accountId)
        .collection('games')
        .doc(gameId);
      const doc = await ref.get();
      if (!doc.exists) return false;
      // Delete subcollections first
      const assignments = await ref.collection('assignments').get();
      for (const a of assignments.docs) {
        await ref.collection('assignments').doc(a.id).delete();
      }
      const crewAssignments = await ref.collection('crewAssignments').get();
      for (const ca of crewAssignments.docs) {
        await ref.collection('crewAssignments').doc(ca.id).delete();
      }
      await ref.delete();
      return true;
    }

    const games = this.memGames.get(accountId);
    if (!games?.has(gameId)) return false;
    games.delete(gameId);
    // Also clean up in-memory assignments
    const key = this.assignmentKey(accountId, gameId);
    this.memAssignments.delete(key);
    this.memCrewAssignments.delete(key);
    return true;
  }

  /**
   * List games across all accounts where a given agent has one of the
   * specified statuses (e.g. SPOTTER with ['done']).
   */
  async listGamesByAgentStatus(
    agentName: import('@apron/types').AgentName,
    statuses: AgentAssignment['status'][],
  ): Promise<Game[]> {
    const results: Game[] = [];
    const accounts = await this.listAccounts();
    for (const acct of accounts) {
      const games = await this.listGames(acct.id);
      for (const g of games) {
        const entry = g.agents?.[agentName];
        if (entry && statuses.includes(entry.status)) {
          results.push({ ...g, accountId: acct.id });
        }
      }
    }
    return results;
  }

  // -------------------------------------------------------------------
  // Agent records (subcollection per game)
  // Path: accounts/{acctId}/games/{gameId}/agents/{agentName}
  // -------------------------------------------------------------------

  /**
   * Get or create an agent record for a game. Each agent gets one
   * document keyed by its name (SPOTTER, TRAFFIC, etc.) with
   * agent-specific fields.
   */
  async getAgentRecord(
    accountId: string,
    gameId: string,
    agentName: string,
  ): Promise<Record<string, unknown> | null> {
    const db = await this.ready();
    if (db) {
      const doc = await db
        .collection('accounts').doc(accountId)
        .collection('games').doc(gameId)
        .collection('agents').doc(agentName)
        .get();
      return doc.exists ? docToRecord(doc) : null;
    }
    const key = `${accountId}:${gameId}`;
    return this.memAgentRecords.get(key)?.get(agentName) ?? null;
  }

  /**
   * Write (upsert) an agent record. Merges with existing data.
   */
  async setAgentRecord(
    accountId: string,
    gameId: string,
    agentName: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const db = await this.ready();
    if (db) {
      const ref = db
        .collection('accounts').doc(accountId)
        .collection('games').doc(gameId)
        .collection('agents').doc(agentName);
      await ref.set({ ...data, agent: agentName, updatedAt: serverTimestamp() }, { merge: true });
      return;
    }
    const key = `${accountId}:${gameId}`;
    if (!this.memAgentRecords.has(key)) {
      this.memAgentRecords.set(key, new Map());
    }
    const existing = this.memAgentRecords.get(key)!.get(agentName) ?? {};
    this.memAgentRecords.get(key)!.set(agentName, { ...existing, ...data, agent: agentName });
  }

  /**
   * List all agent records for a game.
   */
  async listAgentRecords(
    accountId: string,
    gameId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const db = await this.ready();
    if (db) {
      const snap = await db
        .collection('accounts').doc(accountId)
        .collection('games').doc(gameId)
        .collection('agents')
        .get();
      return snap.docs.map(d => docToRecord(d));
    }
    const key = `${accountId}:${gameId}`;
    return [...(this.memAgentRecords.get(key)?.values() ?? [])];
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
      id?: string;
    },
  ): Promise<CrewRecord> {
    const id = data.id ?? randomUUID();
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

  // -------------------------------------------------------------------
  // Crew Game Assignments — rich per-crew-per-game state
  // Path: accounts/{acctId}/games/{gameId}/crewAssignments/{crewId}
  //
  // These are the live documents agents read and update during a game.
  // Each doc stores the full CrewGameAssignment: next call, routing,
  // provenance, board status, etc.
  // -------------------------------------------------------------------

  private crewAssignmentKey(accountId: string, gameId: string): string {
    return `${accountId}:${gameId}`;
  }

  private crewAssignmentRef(db: FirestoreDb, accountId: string, gameId: string) {
    return db
      .collection('accounts')
      .doc(accountId)
      .collection('games')
      .doc(gameId)
      .collection('crewAssignments');
  }

  async listCrewAssignments(
    accountId: string,
    gameId: string,
  ): Promise<CrewGameAssignment[]> {
    const db = await this.ready();
    if (db) {
      const snap = await this.crewAssignmentRef(db, accountId, gameId).get();
      return snap.docs.map(d => docToRecord(d)) as unknown as CrewGameAssignment[];
    }
    const key = this.crewAssignmentKey(accountId, gameId);
    return [...(this.memCrewAssignments.get(key)?.values() ?? [])];
  }

  async getCrewAssignment(
    accountId: string,
    gameId: string,
    crewId: string,
  ): Promise<CrewGameAssignment | null> {
    const db = await this.ready();
    if (db) {
      const doc = await this.crewAssignmentRef(db, accountId, gameId).doc(crewId).get();
      return doc.exists ? (docToRecord(doc) as unknown as CrewGameAssignment) : null;
    }
    const key = this.crewAssignmentKey(accountId, gameId);
    return this.memCrewAssignments.get(key)?.get(crewId) ?? null;
  }

  /**
   * Upsert a single crew game assignment. Keyed by crewId.
   */
  async setCrewAssignment(
    accountId: string,
    gameId: string,
    assignment: CrewGameAssignment,
  ): Promise<void> {
    const db = await this.ready();
    if (db) {
      const ts = serverTimestamp();
      const { crewId, ...rest } = assignment;
      const record = stripUndefined({ ...rest, crewId, updatedAt: ts }) as Record<string, unknown>;
      await this.crewAssignmentRef(db, accountId, gameId)
        .doc(crewId)
        .set(record, { merge: true });
      return;
    }
    const key = this.crewAssignmentKey(accountId, gameId);
    if (!this.memCrewAssignments.has(key)) {
      this.memCrewAssignments.set(key, new Map());
    }
    this.memCrewAssignments.get(key)!.set(assignment.crewId, assignment);
  }

  /**
   * Bulk-write crew game assignments (e.g. initial generation).
   * Replaces any existing assignments for this game.
   */
  async setCrewAssignmentsBatch(
    accountId: string,
    gameId: string,
    assignments: CrewGameAssignment[],
  ): Promise<void> {
    const db = await this.ready();
    if (db) {
      // Delete existing, then write new ones
      const existing = await this.crewAssignmentRef(db, accountId, gameId).get();
      for (const doc of existing.docs) {
        await this.crewAssignmentRef(db, accountId, gameId).doc(doc.id).delete();
      }
      const ts = serverTimestamp();
      for (const a of assignments) {
        const { crewId, ...rest } = a;
        const record = stripUndefined({ ...rest, crewId, createdAt: ts, updatedAt: ts }) as Record<string, unknown>;
        await this.crewAssignmentRef(db, accountId, gameId)
          .doc(crewId)
          .set(record);
      }
      return;
    }
    const key = this.crewAssignmentKey(accountId, gameId);
    const map = new Map<string, CrewGameAssignment>();
    for (const a of assignments) {
      map.set(a.crewId, a);
    }
    this.memCrewAssignments.set(key, map);
  }

  /**
   * Partial update of a crew game assignment — used by agents to
   * update routing, status, etc. without overwriting the full doc.
   */
  async updateCrewAssignment(
    accountId: string,
    gameId: string,
    crewId: string,
    data: Partial<Omit<CrewGameAssignment, 'crewId'>>,
  ): Promise<CrewGameAssignment | null> {
    const db = await this.ready();
    if (db) {
      const ref = this.crewAssignmentRef(db, accountId, gameId).doc(crewId);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const ts = serverTimestamp();
      const record = stripUndefined({ ...data, updatedAt: ts }) as Record<string, unknown>;
      await ref.update(record);
      const updated = await ref.get();
      return docToRecord(updated) as unknown as CrewGameAssignment;
    }

    const key = this.crewAssignmentKey(accountId, gameId);
    const existing = this.memCrewAssignments.get(key)?.get(crewId);
    if (!existing) return null;
    const updated = { ...existing, ...data };
    this.memCrewAssignments.get(key)!.set(crewId, updated);
    return updated;
  }

  async deleteCrewAssignment(
    accountId: string,
    gameId: string,
    crewId: string,
  ): Promise<boolean> {
    const db = await this.ready();
    if (db) {
      const ref = this.crewAssignmentRef(db, accountId, gameId).doc(crewId);
      const doc = await ref.get();
      if (!doc.exists) return false;
      await ref.delete();
      return true;
    }

    const key = this.crewAssignmentKey(accountId, gameId);
    const map = this.memCrewAssignments.get(key);
    if (!map?.has(crewId)) return false;
    map.delete(crewId);
    return true;
  }

  async deleteAllCrewAssignments(
    accountId: string,
    gameId: string,
  ): Promise<number> {
    const db = await this.ready();
    if (db) {
      const snap = await this.crewAssignmentRef(db, accountId, gameId).get();
      for (const doc of snap.docs) {
        await this.crewAssignmentRef(db, accountId, gameId).doc(doc.id).delete();
      }
      return snap.docs.length;
    }

    const key = this.crewAssignmentKey(accountId, gameId);
    const map = this.memCrewAssignments.get(key);
    const count = map?.size ?? 0;
    this.memCrewAssignments.delete(key);
    return count;
  }
}
