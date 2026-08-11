/**
 * Admin API route handler for /api/admin/* routes.
 *
 * Plugs into the raw node:http server — no Express. Parses route params
 * manually via URL pathname splitting, reads JSON bodies from the request
 * stream, and delegates to AdminStore for persistence.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FirestoreStore } from '@apron/integration-firebase';
import { AdminStore, GAME_TYPE_DEFAULTS } from './admin-store.js';
import type { Game, GameType } from './admin-store.js';
import { generateCrewAssignments } from './crew-generator.js';
import type { GeneratorOptions } from './crew-generator.js';
import type { GeminiClient } from '@apron/integration-google-cloud';
import { extractRules, queryAgreement, buildAgreementMeta } from '@apron/agent-steward/agreement';
import type { AgreementMeta, ExtractedRules } from '@apron/agent-steward/agreement';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

let store: AdminStore | null = null;
let gemini: GeminiClient | null = null;

/** Initialize the store singleton eagerly (called from server.ts at startup). */
export function initAdminStore(firestoreStore: FirestoreStore | null, geminiClient?: GeminiClient): AdminStore {
  if (!store) {
    store = new AdminStore(firestoreStore);
  }
  if (geminiClient) {
    gemini = geminiClient;
  }
  return store;
}

/** Expose the store singleton for other modules (e.g. SPOTTER watch). */
export function getAdminStore(): AdminStore | null {
  return store;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read and parse a JSON request body. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Write a JSON response. */
function json(res: ServerResponse, status: number, data: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
  return true;
}

/** Return a 400 with a message. */
function badRequest(res: ServerResponse, message: string): true {
  return json(res, 400, { error: message });
}

/** Return a 404. */
function notFound(res: ServerResponse, what = 'Not found'): true {
  return json(res, 404, { error: what });
}

/** Return a 405 Method Not Allowed. */
function methodNotAllowed(res: ServerResponse): true {
  return json(res, 405, { error: 'Method not allowed' });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

const PREFIX = '/api/admin/';

/**
 * Handle all `/api/admin/*` routes.
 *
 * @returns `true` if the request was handled, `false` if the path did not
 *          match any admin route (caller should fall through to 404).
 */
export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  firestoreStore: FirestoreStore | null,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;

  if (!path.startsWith(PREFIX)) return false;

  const rest = path.slice(PREFIX.length);
  const segments = rest.split('/').filter(s => s.length > 0);
  const method = req.method ?? 'GET';

  // Lazily create the store singleton
  if (!store) {
    store = new AdminStore(firestoreStore);
  }

  // GET /api/admin/me — identify current user across all accounts
  if (segments.length === 1 && segments[0] === 'me') {
    try {
      return await routeMe(req, res, method, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return json(res, 500, { error: message });
    }
  }

  // POST /api/admin/seed — bootstrap demo data
  if (segments.length === 1 && segments[0] === 'seed') {
    try {
      return await routeSeed(req, res, method);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return json(res, 500, { error: message });
    }
  }

  // GET /api/admin/board/:gameId — board data for a specific game
  if (segments.length === 2 && segments[0] === 'board') {
    try {
      return await routeBoard(req, res, method, segments[1]!);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return json(res, 500, { error: message });
    }
  }

  // All admin routes live under /api/admin/accounts/...
  if (segments.length === 0 || segments[0] !== 'accounts') {
    return false;
  }

  try {
    return await routeAccounts(req, res, method, segments);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return json(res, 500, { error: message });
  }
}

// ---------------------------------------------------------------------------
// /api/admin/me — identify current user across all accounts
// ---------------------------------------------------------------------------

/**
 * Dynamic module specifiers — using variables prevents TypeScript from
 * attempting static module resolution against firebase-admin.
 */
const AUTH_MOD = 'firebase-admin/auth';
const ME_APP_MOD = 'firebase-admin/app';

async function routeMe(
  _req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<boolean> {
  if (method !== 'GET') return methodNotAllowed(res);

  // Extract email from query param (demo mode) or Bearer token (Firebase auth)
  let email = url.searchParams.get('email');

  if (!email) {
    const authHeader = _req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        const { getAuth } = await import(AUTH_MOD);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        const { getApp } = await import(ME_APP_MOD);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const decoded = await getAuth(getApp()).verifyIdToken(token);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        email = (decoded.email as string) ?? null;
      } catch {
        // Firebase auth not available or token invalid — fall through
      }
    }
  }

  if (!email) {
    return json(res, 401, {
      error: 'Missing email query parameter or Authorization Bearer token',
    });
  }

  const emailLower = email.toLowerCase();

  // Search all accounts for a member whose email matches (case-insensitive)
  const accounts = await store!.listAccounts();

  for (const account of accounts) {
    const members = await store!.listMembers(account.id);
    const member = members.find(m => m.email.toLowerCase() === emailLower);

    if (member) {
      // Found — enrich with account, entity, and games + assignment counts
      const [entities, games] = await Promise.all([
        store!.listEntities(account.id),
        store!.listGames(account.id),
      ]);

      const entity = entities.find(e => e.id === member.entityId);

      const gamesWithCounts = await Promise.all(
        games.map(async g => {
          const assignments = await store!.listAssignments(account.id, g.id);
          return {
            id: g.id,
            title: g.title,
            network: g.network,
            venue: g.venue,
            date: g.date,
            callTime: g.callTime,
            crewCount: assignments.length,
          };
        }),
      );

      return json(res, 200, {
        member: {
          id: member.id,
          name: member.name,
          email: member.email,
          role: member.role,
        },
        account: {
          id: account.id,
          name: account.name,
          type: account.type,
        },
        entity: entity
          ? { id: entity.id, name: entity.name, type: entity.type }
          : { id: member.entityId, name: member.entityId, type: 'unknown' },
        games: gamesWithCounts,
      });
    }
  }

  return notFound(res, 'No member found for this email');
}

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

async function routeAccounts(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
): Promise<boolean> {
  // GET/POST /api/admin/accounts
  if (segments.length === 1) {
    if (method === 'GET') {
      const accounts = await store!.listAccounts();
      return json(res, 200, accounts);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body['name'] || typeof body['name'] !== 'string') {
        return badRequest(res, 'Missing required field: name');
      }
      const account = await store!.createAccount({
        name: body['name'] as string,
        type: typeof body['type'] === 'string' ? body['type'] : undefined,
      });
      return json(res, 201, account);
    }
    return methodNotAllowed(res);
  }

  const accountId = segments[1]!;

  // GET /api/admin/accounts/:id
  if (segments.length === 2) {
    if (method !== 'GET') return methodNotAllowed(res);
    const account = await store!.getAccount(accountId);
    if (!account) return notFound(res, 'Account not found');
    return json(res, 200, account);
  }

  const resource = segments[2];

  // Dispatch to sub-resource handlers
  switch (resource) {
    case 'entities':
      return routeEntities(req, res, method, accountId, segments);
    case 'members':
      return routeMembers(req, res, method, accountId, segments);
    case 'games':
      return routeGames(req, res, method, accountId, segments);
    case 'crew':
      return routeCrew(req, res, method, accountId, segments);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

async function routeEntities(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  accountId: string,
  segments: string[],
): Promise<boolean> {
  // GET/POST /api/admin/accounts/:id/entities
  if (segments.length === 3) {
    if (method === 'GET') {
      const entities = await store!.listEntities(accountId);
      return json(res, 200, entities);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const type = body['type'];
      if (type !== 'tmc' && type !== 'production') {
        return badRequest(res, 'Field "type" must be "tmc" or "production"');
      }
      if (!body['name'] || typeof body['name'] !== 'string') {
        return badRequest(res, 'Missing required field: name');
      }
      const entity = await store!.createEntity(accountId, {
        type,
        name: body['name'] as string,
      });
      return json(res, 201, entity);
    }
    return methodNotAllowed(res);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

async function routeMembers(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  accountId: string,
  segments: string[],
): Promise<boolean> {
  // GET/POST /api/admin/accounts/:id/members
  if (segments.length === 3) {
    if (method === 'GET') {
      const [members, entities] = await Promise.all([
        store!.listMembers(accountId),
        store!.listEntities(accountId),
      ]);
      const entityMap = new Map(entities.map(e => [e.id, e.name]));
      const enriched = members.map(m => ({
        ...m,
        entityName: entityMap.get(m.entityId) ?? m.entityId,
      }));
      return json(res, 200, enriched);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      for (const field of ['entityId', 'role', 'email', 'name'] as const) {
        if (!body[field] || typeof body[field] !== 'string') {
          return badRequest(res, `Missing required field: ${field}`);
        }
      }
      const member = await store!.createMember(accountId, {
        entityId: body['entityId'] as string,
        role: body['role'] as string,
        email: body['email'] as string,
        name: body['name'] as string,
      });
      return json(res, 201, member);
    }
    return methodNotAllowed(res);
  }

  // DELETE /api/admin/accounts/:id/members/:memberId
  if (segments.length === 4) {
    const memberId = segments[3]!;
    if (method !== 'DELETE') return methodNotAllowed(res);
    const deleted = await store!.deleteMember(accountId, memberId);
    if (!deleted) return notFound(res, 'Member not found');
    return json(res, 200, { ok: true });
  }

  return false;
}

// ---------------------------------------------------------------------------
// Games (+ nested assignments)
// ---------------------------------------------------------------------------

async function routeGames(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  accountId: string,
  segments: string[],
): Promise<boolean> {
  // GET/POST /api/admin/accounts/:id/games
  if (segments.length === 3) {
    if (method === 'GET') {
      const games = await store!.listGames(accountId);
      return json(res, 200, games);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      for (const field of ['network', 'title', 'venue', 'date'] as const) {
        if (!body[field] || typeof body[field] !== 'string') {
          return badRequest(res, `Missing required field: ${field}`);
        }
      }
      const game = await store!.createGame(accountId, {
        network: body['network'] as string,
        title: body['title'] as string,
        venue: body['venue'] as string,
        date: body['date'] as string,
        callTime: typeof body['callTime'] === 'string' ? body['callTime'] : undefined,
        crewCount: typeof body['crewCount'] === 'number' ? body['crewCount'] : undefined,
        gameType: typeof body['gameType'] === 'string' ? body['gameType'] as GameType : undefined,
        startTime: typeof body['startTime'] === 'string' ? body['startTime'] : undefined,
        expectedEndTime: typeof body['expectedEndTime'] === 'string' ? body['expectedEndTime'] : undefined,
        expectedDuration: typeof body['expectedDuration'] === 'number' ? body['expectedDuration'] : undefined,
        strikeDuration: typeof body['strikeDuration'] === 'number' ? body['strikeDuration'] : undefined,
        venueToTransport: typeof body['venueToTransport'] === 'number' ? body['venueToTransport'] : undefined,
        transportDuration: typeof body['transportDuration'] === 'number' ? body['transportDuration'] : undefined,
        departureAirport: typeof body['departureAirport'] === 'string' ? body['departureAirport'] : undefined,
        overnightLabel: typeof body['overnightLabel'] === 'string' ? body['overnightLabel'] : undefined,
        lobbyCallTime: typeof body['lobbyCallTime'] === 'string' ? body['lobbyCallTime'] : undefined,
        minRestHours: typeof body['minRestHours'] === 'number' ? body['minRestHours'] : undefined,
        espnEventId: typeof body['espnEventId'] === 'string' ? body['espnEventId'] : undefined,
      });
      return json(res, 201, game);
    }
    return methodNotAllowed(res);
  }

  const gameId = segments[3]!;

  // GET/PATCH/DELETE /api/admin/accounts/:id/games/:gameId
  if (segments.length === 4) {
    if (method === 'GET') {
      const game = await store!.getGame(accountId, gameId);
      if (!game) return notFound(res, 'Game not found');
      return json(res, 200, game);
    }
    if (method === 'DELETE') {
      const deleted = await store!.deleteGame(accountId, gameId);
      if (!deleted) return notFound(res, 'Game not found');
      return json(res, 200, { ok: true });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      const strFields = [
        'network', 'title', 'venue', 'date', 'callTime',
        'gameType', 'startTime', 'expectedEndTime', 'departureAirport',
        'overnightLabel', 'lobbyCallTime', 'espnEventId',
      ] as const;
      for (const field of strFields) {
        if (typeof body[field] === 'string') patch[field] = body[field];
      }
      const numFields = [
        'crewCount', 'expectedDuration', 'strikeDuration',
        'venueToTransport', 'transportDuration', 'minRestHours',
      ] as const;
      for (const field of numFields) {
        if (typeof body[field] === 'number') patch[field] = body[field];
      }
      const game = await store!.updateGame(accountId, gameId, patch);
      if (!game) return notFound(res, 'Game not found');
      return json(res, 200, game);
    }
    return methodNotAllowed(res);
  }

  // Nested assignments: /api/admin/accounts/:id/games/:gameId/assignments/...
  if (segments.length >= 5 && segments[4] === 'assignments') {
    return routeAssignments(req, res, method, accountId, gameId, segments);
  }

  // Nested crew assignments: /api/admin/accounts/:id/games/:gameId/crewAssignments/...
  if (segments.length >= 5 && segments[4] === 'crewAssignments') {
    return routeCrewAssignments(req, res, method, accountId, gameId, segments);
  }

  // Nested agreement: /api/admin/accounts/:id/games/:gameId/agreement/...
  if (segments.length >= 5 && segments[4] === 'agreement') {
    return routeAgreement(req, res, method, accountId, gameId, segments);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Crew
// ---------------------------------------------------------------------------

async function routeCrew(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  accountId: string,
  segments: string[],
): Promise<boolean> {
  // GET/POST /api/admin/accounts/:id/crew
  if (segments.length === 3) {
    if (method === 'GET') {
      const crew = await store!.listCrew(accountId);
      return json(res, 200, crew);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      for (const field of ['name', 'position', 'department', 'homeMarket'] as const) {
        if (!body[field] || typeof body[field] !== 'string') {
          return badRequest(res, `Missing required field: ${field}`);
        }
      }
      const crew = await store!.createCrew(accountId, {
        name: body['name'] as string,
        position: body['position'] as string,
        department: body['department'] as string,
        homeMarket: body['homeMarket'] as string,
        tier: typeof body['tier'] === 'string' ? body['tier'] : undefined,
      });
      return json(res, 201, crew);
    }
    return methodNotAllowed(res);
  }

  // GET/PATCH /api/admin/accounts/:id/crew/:crewId
  if (segments.length === 4) {
    const crewId = segments[3]!;
    if (method === 'GET') {
      const crew = await store!.getCrew(accountId, crewId);
      if (!crew) return notFound(res, 'Crew member not found');
      return json(res, 200, crew);
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const field of ['name', 'position', 'department', 'homeMarket', 'tier'] as const) {
        if (typeof body[field] === 'string') patch[field] = body[field];
      }
      const crew = await store!.updateCrew(accountId, crewId, patch);
      if (!crew) return notFound(res, 'Crew member not found');
      return json(res, 200, crew);
    }
    return methodNotAllowed(res);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

async function routeAssignments(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  accountId: string,
  gameId: string,
  segments: string[],
): Promise<boolean> {
  // GET/POST /api/admin/accounts/:id/games/:gameId/assignments
  if (segments.length === 5) {
    if (method === 'GET') {
      const [assignments, crew] = await Promise.all([
        store!.listAssignments(accountId, gameId),
        store!.listCrew(accountId),
      ]);
      const crewMap = new Map(crew.map(c => [c.id, c.name]));
      const enriched = assignments.map(a => ({
        ...a,
        crewName: crewMap.get(a.crewId) ?? a.crewId,
      }));
      return json(res, 200, enriched);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body['crewId'] || typeof body['crewId'] !== 'string') {
        return badRequest(res, 'Missing required field: crewId');
      }
      const assignment = await store!.createAssignment(accountId, gameId, {
        crewId: body['crewId'] as string,
        position: typeof body['position'] === 'string' ? body['position'] : undefined,
        notes: typeof body['notes'] === 'string' ? body['notes'] : undefined,
      });
      return json(res, 201, assignment);
    }
    return methodNotAllowed(res);
  }

  // DELETE /api/admin/accounts/:id/games/:gameId/assignments/:assignmentId
  if (segments.length === 6) {
    const assignmentId = segments[5]!;
    if (method !== 'DELETE') return methodNotAllowed(res);
    const deleted = await store!.deleteAssignment(accountId, gameId, assignmentId);
    if (!deleted) return notFound(res, 'Assignment not found');
    return json(res, 200, { ok: true });
  }

  return false;
}

// ---------------------------------------------------------------------------
// Crew Game Assignments — rich per-crew-per-game state for agents
// ---------------------------------------------------------------------------

async function routeCrewAssignments(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  accountId: string,
  gameId: string,
  segments: string[],
): Promise<boolean> {
  // POST /api/admin/accounts/:id/games/:gameId/crewAssignments/generate
  // Generates crew assignments from the roster using the crew-generator
  if (segments.length === 6 && segments[5] === 'generate') {
    if (method !== 'POST') return methodNotAllowed(res);

    const game = await store!.getGame(accountId, gameId);
    if (!game) return notFound(res, 'Game not found');

    // Get assigned crew for this game
    const [assignments, allCrew] = await Promise.all([
      store!.listAssignments(accountId, gameId),
      store!.listCrew(accountId),
    ]);

    if (assignments.length === 0) {
      return badRequest(res, 'No crew assigned to this game — assign crew first');
    }

    const crewMap = new Map(allCrew.map(c => [c.id, c]));
    const assignedCrew = assignments
      .map(a => crewMap.get(a.crewId))
      .filter((c): c is NonNullable<typeof c> => c != null);

    if (assignedCrew.length === 0) {
      return badRequest(res, 'No matching crew records found');
    }

    // Parse optional generator options from request body
    const body = await readBody(req);
    const opts: GeneratorOptions = {};
    if (typeof body['externalCallRate'] === 'number') opts.externalCallRate = body['externalCallRate'];
    if (typeof body['disclosureRate'] === 'number') opts.disclosureRate = body['disclosureRate'];
    if (typeof body['includeSameProduction'] === 'boolean') opts.includeSameProduction = body['includeSameProduction'];
    if (body['nextShow'] && typeof body['nextShow'] === 'object') {
      const ns = body['nextShow'] as Record<string, unknown>;
      if (typeof ns['title'] === 'string' && typeof ns['airport'] === 'string') {
        opts.nextShow = {
          title: ns['title'] as string,
          shortName: (ns['shortName'] as string) ?? ns['title'] as string,
          venue: (ns['venue'] as string) ?? '',
          airport: ns['airport'] as string,
          callTime: (ns['callTime'] as string) ?? '13:00',
          callDate: (ns['callDate'] as string) ?? game.date,
          tz: (ns['tz'] as string) ?? 'ET',
        };
      }
    }

    const crewAssignments = generateCrewAssignments(assignedCrew, game, opts);

    // Persist to Firestore
    await store!.setCrewAssignmentsBatch(accountId, gameId, crewAssignments);

    return json(res, 201, {
      generated: crewAssignments.length,
      assignments: crewAssignments,
    });
  }

  // GET /api/admin/accounts/:id/games/:gameId/crewAssignments
  if (segments.length === 5) {
    if (method === 'GET') {
      const crewAssignments = await store!.listCrewAssignments(accountId, gameId);
      return json(res, 200, crewAssignments);
    }
    // DELETE all — clear crew assignments for this game
    if (method === 'DELETE') {
      const count = await store!.deleteAllCrewAssignments(accountId, gameId);
      return json(res, 200, { deleted: count });
    }
    return methodNotAllowed(res);
  }

  // GET/PATCH/DELETE /api/admin/accounts/:id/games/:gameId/crewAssignments/:crewId
  if (segments.length === 6) {
    const crewId = segments[5]!;

    if (method === 'GET') {
      const assignment = await store!.getCrewAssignment(accountId, gameId, crewId);
      if (!assignment) return notFound(res, 'Crew assignment not found');
      return json(res, 200, assignment);
    }

    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      // Allow updating status, routing, nextCall
      if (body['status'] != null) patch['status'] = body['status'];
      if (body['routing'] != null) patch['routing'] = body['routing'];
      if (body['nextCall'] != null) patch['nextCall'] = body['nextCall'];
      const updated = await store!.updateCrewAssignment(accountId, gameId, crewId, patch);
      if (!updated) return notFound(res, 'Crew assignment not found');
      return json(res, 200, updated);
    }

    if (method === 'DELETE') {
      const deleted = await store!.deleteCrewAssignment(accountId, gameId, crewId);
      if (!deleted) return notFound(res, 'Crew assignment not found');
      return json(res, 200, { ok: true });
    }

    return methodNotAllowed(res);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Agreement — STEWARD agent agreement loading and rule extraction
// Path: /api/admin/accounts/:id/games/:gameId/agreement/...
// ---------------------------------------------------------------------------

/** Resolve the default NABET agreement text bundled with the project. */
function loadDefaultAgreement(): { text: string; name: string; source: string } {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const txtPath = resolve(__dirname, '../../../agreements/nabet-cwa-nbcu-2022-2027.txt');
  const text = readFileSync(txtPath, 'utf-8');
  return {
    text,
    name: 'NABET-CWA/NBCUniversal 2022-2027 Master Agreement',
    source: 'https://nabetlocal11.org/system/files/2025-02/nabet_master_agreement_2022_-_2027_final_draft_0.pdf',
  };
}

async function routeAgreement(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  accountId: string,
  gameId: string,
  segments: string[],
): Promise<boolean> {
  const game = await store!.getGame(accountId, gameId);
  if (!game) return notFound(res, 'Game not found');

  // GET/DELETE /api/admin/accounts/:id/games/:gameId/agreement
  if (segments.length === 5) {
    if (method === 'GET') {
      const record = await store!.getAgentRecord(accountId, gameId, 'STEWARD');
      if (!record) {
        return json(res, 200, { loaded: false, agreement: null, rules: null });
      }
      const agreement = record['agreement'] ?? null;
      return json(res, 200, {
        loaded: !!agreement,
        agreement,
        rules: record['rules'] ?? null,
      });
    }
    if (method === 'DELETE') {
      await store!.setAgentRecord(accountId, gameId, 'STEWARD', {
        agreement: null,
        agreementText: null,
        rules: null,
      });
      await store!.setAgentAssignment(accountId, gameId, 'STEWARD', {
        status: 'idle',
        startedAt: new Date().toISOString(),
      });
      return json(res, 200, { removed: true });
    }
    return methodNotAllowed(res);
  }

  const action = segments[5];

  // POST /api/admin/accounts/:id/games/:gameId/agreement/load
  // Loads the default agreement (or custom text) and stores it on the STEWARD agent record.
  // Optional body: { text?: string, name?: string, source?: string }
  if (action === 'load') {
    if (method !== 'POST') return methodNotAllowed(res);

    const body = await readBody(req);
    let text: string;
    let name: string;
    let source: string;

    if (typeof body['text'] === 'string' && body['text'].length > 0) {
      text = body['text'] as string;
      name = (body['name'] as string) ?? 'Custom Agreement';
      source = (body['source'] as string) ?? 'manual upload';
    } else {
      // Load the bundled NABET agreement
      const defaultAgreement = loadDefaultAgreement();
      text = defaultAgreement.text;
      name = defaultAgreement.name;
      source = defaultAgreement.source;
    }

    const meta = buildAgreementMeta(name, text, source);

    // Store on the STEWARD agent record
    await store!.setAgentRecord(accountId, gameId, 'STEWARD', {
      agreement: meta,
      agreementText: text,
    });

    // Set agent lifecycle to active
    await store!.setAgentAssignment(accountId, gameId, 'STEWARD', {
      status: 'active',
      startedAt: new Date().toISOString(),
    });

    return json(res, 200, {
      loaded: true,
      agreement: meta,
      rules: null,
      message: `Agreement loaded: ${name} (${meta.textLength.toLocaleString()} chars)`,
    });
  }

  // POST /api/admin/accounts/:id/games/:gameId/agreement/extract
  // Runs Gemini one-time extraction to produce structured rules
  if (action === 'extract') {
    if (method !== 'POST') return methodNotAllowed(res);

    const record = await store!.getAgentRecord(accountId, gameId, 'STEWARD');
    const agreementText = record?.['agreementText'] as string | undefined;
    if (!agreementText) {
      return badRequest(res, 'No agreement loaded — call /agreement/load first');
    }

    if (!gemini?.isEnabled()) {
      return json(res, 200, {
        rules: null,
        message: '[fixture mode] Gemini not available — rules extraction skipped',
      });
    }

    const rules = await extractRules(gemini, agreementText);
    if (!rules) {
      return json(res, 500, { error: 'Gemini extraction returned no result' });
    }

    // Store the extracted rules
    await store!.setAgentRecord(accountId, gameId, 'STEWARD', {
      rules,
    });

    return json(res, 200, { rules });
  }

  // POST /api/admin/accounts/:id/games/:gameId/agreement/query
  // Live query: send a question about the agreement to Gemini
  if (action === 'query') {
    if (method !== 'POST') return methodNotAllowed(res);

    const body = await readBody(req);
    const question = body['question'] as string;
    if (!question || typeof question !== 'string') {
      return badRequest(res, 'Missing required field: question');
    }

    const record = await store!.getAgentRecord(accountId, gameId, 'STEWARD');
    const agreementText = record?.['agreementText'] as string | undefined;
    if (!agreementText) {
      return badRequest(res, 'No agreement loaded — call /agreement/load first');
    }

    if (!gemini?.isEnabled()) {
      return json(res, 200, {
        answer: `[fixture mode] STEWARD would query: ${question}`,
        citations: [],
        confidence: 'low',
      });
    }

    const operationalContext = body['context'] as Record<string, unknown> | undefined;
    const result = await queryAgreement(gemini, agreementText, question, operationalContext);

    return json(res, 200, result);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Seed — bootstrap demo data
// ---------------------------------------------------------------------------

async function routeSeed(
  _req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<boolean> {
  if (method !== 'POST') return methodNotAllowed(res);

  // Check if data already exists
  const existing = await store!.listAccounts();
  if (existing.length > 0) {
    return json(res, 200, { seeded: false, message: 'Data already exists', accounts: existing.length });
  }

  // Deterministic IDs so game URLs survive server restarts
  const ACCT_ID = 'acct-ctm-entertainment';
  const TMC_ID = 'entity-sports-travel-desk';
  const PROD_ID = 'entity-production-coordination';
  const GAME_ID = 'alcs-gm4-rangers-guardians';

  // 1. Account
  const acct = await store!.createAccount({ id: ACCT_ID, name: 'CTM Entertainment', type: 'hybrid' });

  // 2. Entities
  const tmcEntity = await store!.createEntity(acct.id, { id: TMC_ID, type: 'tmc', name: 'Sports Travel Desk' });
  const prodEntity = await store!.createEntity(acct.id, { id: PROD_ID, type: 'production', name: 'Production Coordination' });

  // 3. Members (Gmail plus addressing)
  await store!.createMember(acct.id, {
    id: 'member-coordinator',
    entityId: prodEntity.id,
    role: 'coordinator',
    email: 'markmcspadden+coordinator@gmail.com',
    name: 'Mark McSpadden',
  });
  await store!.createMember(acct.id, {
    id: 'member-agent',
    entityId: tmcEntity.id,
    role: 'desk_agent',
    email: 'markmcspadden+agent@gmail.com',
    name: 'Mark McSpadden',
  });
  await store!.createMember(acct.id, {
    id: 'member-lead',
    entityId: tmcEntity.id,
    role: 'desk_lead',
    email: 'markmcspadden+lead@gmail.com',
    name: 'Mark McSpadden',
  });

  // 4. Crew
  const crewData = [
    { id: 'crew-callahan', name: 'Mike Callahan', position: 'TD', department: 'Truck', homeMarket: 'New York, NY', tier: 'A-list' },
    { id: 'crew-vasquez', name: 'Sarah Vasquez', position: 'DIR', department: 'Truck', homeMarket: 'Los Angeles, CA', tier: 'A-list' },
    { id: 'crew-kessler', name: 'Dave Kessler', position: 'A1', department: 'Audio booth', homeMarket: 'Chicago, IL', tier: 'A-list' },
    { id: 'crew-rinaldi', name: 'Tony Rinaldi', position: 'EIC', department: 'Engineering', homeMarket: 'New York, NY', tier: 'A-list' },
    { id: 'crew-nguyen', name: 'Beth Nguyen', position: 'GFX', department: 'Graphics', homeMarket: 'Atlanta, GA', tier: 'B-list' },
    { id: 'crew-wright', name: 'James Wright', position: 'LEAD EVS', department: 'Tape room', homeMarket: 'Dallas, TX', tier: 'A-list' },
  ] as const;

  const crew = [];
  for (const c of crewData) {
    crew.push(await store!.createCrew(acct.id, { ...c }));
  }

  // 5. Game (with full timing model)
  const game = await store!.createGame(acct.id, {
    id: GAME_ID,
    network: 'FOX',
    title: 'ALCS Gm 4 - Rangers @ Guardians',
    venue: 'Progressive Field, Cleveland',
    date: '2026-10-17',
    callTime: '14:00',
    gameType: 'baseball',
    startTime: '19:08',
    expectedEndTime: '22:58',        // can be overridden live
    strikeDuration: 75,               // 75min load-out at Progressive Field
    venueToTransport: 15,             // 15min venue → shuttle
    transportDuration: 27,            // 27min shuttle → airport hotel
    departureAirport: 'CLE',
    overnightLabel: 'Airport hotel',
    lobbyCallTime: '04:30',           // next morning lobby
    minRestHours: 8,                  // NABET Art. 8.3
  });

  // 6. Assignments
  for (const c of crew) {
    await store!.createAssignment(acct.id, game.id, {
      crewId: c.id,
      position: c.position,
    });
  }

  return json(res, 201, {
    seeded: true,
    account: acct.id,
    entities: [tmcEntity.id, prodEntity.id],
    members: 3,
    crew: crew.length,
    games: 1,
    assignments: crew.length,
  });
}

// ---------------------------------------------------------------------------
// Chain computation — wrap-to-gate timing from game data
// ---------------------------------------------------------------------------

/** Parse "HH:MM" into total minutes since midnight. */
function parseHM(hm: string): number {
  const [h, m] = hm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** Format total minutes as "HH:MM". Wraps past midnight. */
function fmtHM(totalMin: number): string {
  const wrapped = ((totalMin % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/** Format a minute count as "Xh YYm". */
function fmtDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

interface ChainNode {
  label: string;
  time: string;          // "HH:MM" or "XhYYm" for durations
  isDuration?: boolean;
  minutesMark: number;   // minutes since midnight (for diff calculations)
}

/**
 * Compute the wrap-to-gate chain from a Game's timing fields.
 * Returns null if insufficient timing data is configured.
 */
function computeChain(game: Game): ChainNode[] | null {
  // Need at least an end time to build a chain
  let endMin: number;

  if (game.expectedEndTime) {
    endMin = parseHM(game.expectedEndTime);
  } else if (game.startTime) {
    const defaults = game.gameType ? GAME_TYPE_DEFAULTS[game.gameType] : null;
    const dur = game.expectedDuration ?? defaults?.duration ?? 180;
    endMin = parseHM(game.startTime) + dur;
  } else {
    return null; // not enough data
  }

  const defaults = game.gameType ? GAME_TYPE_DEFAULTS[game.gameType] : null;
  const strikeMins = game.strikeDuration ?? defaults?.strike ?? 75;
  const venueToTransport = game.venueToTransport ?? 15;
  const transportDur = game.transportDuration ?? 27;
  const minRest = (game.minRestHours ?? 8) * 60;

  const strikeEnd = endMin + strikeMins;
  const shuttleRolls = strikeEnd + venueToTransport;
  const overnightArr = shuttleRolls + transportDur;

  const chain: ChainNode[] = [
    { label: 'Final out', time: fmtHM(endMin), minutesMark: endMin },
    { label: 'Strike complete', time: fmtHM(strikeEnd), minutesMark: strikeEnd },
    { label: 'Shuttle rolls', time: fmtHM(shuttleRolls), minutesMark: shuttleRolls },
    { label: game.overnightLabel ?? 'Airport hotel', time: fmtHM(overnightArr), minutesMark: overnightArr },
  ];

  // Add rest duration node if we have a lobby call time
  if (game.lobbyCallTime) {
    const lobbyMin = parseHM(game.lobbyCallTime);
    // Rest = lobby - overnight arrival (may wrap past midnight)
    let restMins = lobbyMin - (overnightArr % 1440);
    if (restMins < 0) restMins += 1440;

    chain.push({
      label: `Rest before ${game.lobbyCallTime} lobby`,
      time: fmtDuration(restMins),
      isDuration: true,
      minutesMark: restMins,
    });
  }

  return chain;
}

// ---------------------------------------------------------------------------
// /api/admin/board/:gameId — full board data for a game
// ---------------------------------------------------------------------------

async function routeBoard(
  _req: IncomingMessage,
  res: ServerResponse,
  method: string,
  gameId: string,
): Promise<boolean> {
  if (method !== 'GET') return methodNotAllowed(res);

  // Search all accounts for the game
  const accounts = await store!.listAccounts();

  for (const account of accounts) {
    const game = await store!.getGame(account.id, gameId);
    if (!game) continue;

    // Found the game — load assignments, crew, entities, and crew assignments
    const [assignments, allCrew, entities, crewAssignments] = await Promise.all([
      store!.listAssignments(account.id, gameId),
      store!.listCrew(account.id),
      store!.listEntities(account.id),
      store!.listCrewAssignments(account.id, gameId),
    ]);

    const crewMap = new Map(allCrew.map(c => [c.id, c]));

    // Build enriched roster: join assignments with crew records
    const roster = assignments.map(a => {
      const crew = crewMap.get(a.crewId);
      return {
        assignmentId: a.id,
        crewId: a.crewId,
        position: a.position ?? crew?.position ?? '',
        name: crew?.name ?? a.crewId,
        department: crew?.department ?? '',
        homeMarket: crew?.homeMarket ?? '',
        tier: crew?.tier ?? '',
        notes: a.notes ?? '',
      };
    });

    // Compute the wrap-to-gate chain from game timing data
    const chain = computeChain(game);

    return json(res, 200, {
      game: {
        id: game.id,
        title: game.title,
        network: game.network,
        venue: game.venue,
        date: game.date,
        callTime: game.callTime,
        gameType: game.gameType,
        startTime: game.startTime,
        expectedEndTime: game.expectedEndTime,
        strikeDuration: game.strikeDuration,
        departureAirport: game.departureAirport,
        lobbyCallTime: game.lobbyCallTime,
        minRestHours: game.minRestHours ?? 8,
      },
      account: {
        id: account.id,
        name: account.name,
      },
      entities: entities.map(e => ({ id: e.id, name: e.name, type: e.type })),
      roster,
      crewAssignments,
      chain,
    });
  }

  return notFound(res, 'Game not found');
}
