/**
 * Admin API route handler for /api/admin/* routes.
 *
 * Plugs into the raw node:http server — no Express. Parses route params
 * manually via URL pathname splitting, reads JSON bodies from the request
 * stream, and delegates to AdminStore for persistence.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FirestoreStore } from '@apron/integration-firebase';
import { AdminStore } from './admin-store.js';

// ---------------------------------------------------------------------------
// Module-level singleton — created on first request
// ---------------------------------------------------------------------------

let store: AdminStore | null = null;

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
      });
      return json(res, 201, game);
    }
    return methodNotAllowed(res);
  }

  const gameId = segments[3]!;

  // GET/PATCH /api/admin/accounts/:id/games/:gameId
  if (segments.length === 4) {
    if (method === 'GET') {
      const game = await store!.getGame(accountId, gameId);
      if (!game) return notFound(res, 'Game not found');
      return json(res, 200, game);
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const field of ['network', 'title', 'venue', 'date', 'callTime'] as const) {
        if (typeof body[field] === 'string') patch[field] = body[field];
      }
      if (typeof body['crewCount'] === 'number') patch['crewCount'] = body['crewCount'];
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
