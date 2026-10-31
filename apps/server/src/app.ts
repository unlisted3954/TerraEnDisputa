import { z } from 'zod';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { PlayerId, PlayerState } from '@game/game-engine';
import { hasGameClock, humanSeats } from '@game/game-engine';
import {
  MAX_WEBSOCKET_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  adminLoginBodySchema,
  adminLaunchBodySchema,
  clientCommandSchema,
  takeSeatBodySchema,
  confirmGameActionBodySchema,
  createGameBodySchema,
  gameIdParamsSchema,
  gamePlayerParamsSchema,
  joinGameBodySchema,
  protocolErrorCodeSchema,
  updateGameConfigurationBodySchema,
  configureBotsBodySchema,
  assignBotBodySchema,
} from '@game/protocol';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { AdminLaunch, isLoopback } from './admin-launch.js';
import { connectionOptions } from './connection-options.js';
import { APPLICATION_VERSION } from './version.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RawData } from 'ws';

import {
  AuthenticationOperationError,
  AuthenticationService,
} from './auth/authentication.js';
import {
  clearSessionCookie,
  createSessionCookie,
  readSessionCookie,
} from './auth/cookies.js';
import type { TransportClass } from './auth/types.js';
import { GameService } from './games/game-service.js';
import {
  LiveConnectionRegistry,
  type LiveConnection,
} from './games/live-connections.js';
import {
  GameLifecycleService,
  LifecycleOperationError,
} from './games/lifecycle-service.js';
import { PerGameCoordinator } from './games/per-game-coordinator.js';
import { projectGameFor, projectGameForAdmin } from './games/projection.js';
import { secureGameRandomness } from './games/randomness.js';
import type { FileGameStore } from './persistence/file-game-store.js';
import { StaleGameRevisionError } from './persistence/file-game-store.js';
import { StaleAuthenticationStateError } from './persistence/file-game-store.js';
import {
  PersistenceFailedError,
  PersistenceIndeterminateError,
} from './persistence/atomic-file.js';
import {
  addressKey,
  LayeredRateLimiter,
  LoginBackoff,
  type RateLimitPolicy,
  type RateLimitSurface,
} from './security/rate-limiter.js';
import { hasValidOrigin, isAllowedHost } from './security/origin.js';

/** A host name or address with an optional port, and nothing a policy could misread. */
const SOCKET_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

interface ServerOptions {
  readonly connectionBind?: string;
  readonly connectionPort?: number;
  readonly adminLaunch?: AdminLaunch;
  readonly onClose?: () => Promise<void>;
  readonly store?: FileGameStore;
  readonly webRoot?: string;
  readonly publicOrigin?: string;
  readonly trustedProxy?: string | readonly string[];
  readonly logger?: boolean;
  readonly rateLimitPolicies?: Readonly<
    Record<RateLimitSurface, RateLimitPolicy>
  >;
  readonly rateLimitNow?: () => number;
  readonly gameIdGenerator?: () => string;
  readonly clockNow?: () => number;
  readonly clockIntervalMs?: number;
}

type RequestSecurityContext = Pick<
  FastifyRequest,
  'protocol' | 'headers' | 'hostname' | 'cookies'
>;
/** Too many host checks from one address; answered with 429. */
class HostCheckLimitedError extends Error {}

const transportClass = (request: RequestSecurityContext): TransportClass =>
  request.protocol === 'https' ? 'HTTPS' : 'HTTP';
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({
    logger: options.logger ?? true,
    bodyLimit: MAX_WEBSOCKET_MESSAGE_BYTES,
    ...(options.trustedProxy === undefined
      ? {}
      : {
          trustProxy:
            typeof options.trustedProxy === 'string'
              ? options.trustedProxy
              : [...options.trustedProxy],
        }),
  });
  const store = options.store;
  const coordinator = new PerGameCoordinator();
  const auth = store
    ? new AuthenticationService(store, undefined, coordinator)
    : undefined;
  const games = store
    ? new GameService(
        store,
        coordinator,
        options.clockNow ?? Date.now,
        (gameId, playerId) =>
          connections.forGame(gameId).some((c) => c.playerId === playerId),
      )
    : undefined;
  const lifecycle = store
    ? new GameLifecycleService(
        store,
        coordinator,
        secureGameRandomness,
        options.gameIdGenerator ?? randomUUID,
        options.clockNow ?? Date.now,
      )
    : undefined;
  const connections = new LiveConnectionRegistry((gameId, playerId, error) =>
    server.log.warn(
      { err: error, gameId, playerId },
      'WebSocket delivery failed',
    ),
  );
  const rateLimiter = new LayeredRateLimiter(
    options.rateLimitPolicies,
    options.rateLimitNow,
  );
  const loginBackoff = new LoginBackoff(options.rateLimitNow);
  if (!store) server.addHook('preClose', () => connections.closeAll());
  // Behind a trusted proxy, the proxy already decides which names reach us.
  if (options.trustedProxy === undefined)
    server.addHook('onRequest', async (request, reply) => {
      if (!isAllowedHost(request.hostname, options.publicOrigin))
        return reply.code(421).send({ code: 'HOST_NOT_ALLOWED' });
    });
  const publicHost = options.publicOrigin
    ? new URL(options.publicOrigin).host
    : undefined;
  server.addHook('onSend', async (request, reply) => {
    // Live connections go only to this server. Current browsers already read
    // 'self' that way; the names spelled out cover older Safari.
    const sockets = [...new Set([request.headers.host, publicHost])]
      .filter((host) => host !== undefined && SOCKET_HOST.test(host))
      .flatMap((host) => [`ws://${host}`, `wss://${host}`])
      .join(' ');
    void reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY')
      .header(
        'Content-Security-Policy',
        `default-src 'self'; connect-src 'self'${sockets ? ` ${sockets}` : ''}; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
      );
  });
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof HostCheckLimitedError)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many attempts; try again later',
      });
    // Fastify's own rejections (broken JSON, oversized or unsupported bodies)
    // are the client's mistake: keep their status and stay out of the error log.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      request.log.info({ err: error }, 'Request rejected');
      return reply
        .code(status)
        .send({ code: 'MALFORMED_MESSAGE', message: 'MALFORMED_MESSAGE' });
    }
    request.log.error(error, 'Request failed');
    if (error instanceof AuthenticationOperationError) {
      const status =
        error.code === 'GAME_NOT_FOUND' || error.code === 'PLAYER_NOT_FOUND'
          ? 404
          : 409;
      return reply.code(status).send({ code: error.code, message: error.code });
    }
    if (error instanceof LifecycleOperationError) {
      const status = error.code === 'GAME_NOT_FOUND' ? 404 : 409;
      return reply.code(status).send({ code: error.code, message: error.code });
    }
    if (
      error instanceof StaleGameRevisionError ||
      error instanceof StaleAuthenticationStateError
    )
      return reply.code(409).send({
        code: 'STALE_REVISION',
        message: 'Authoritative state changed concurrently',
      });
    if (error instanceof PersistenceIndeterminateError)
      return reply.code(503).send({
        code: 'GAME_UNAVAILABLE',
        message: 'Game is unavailable until restart recovery',
      });
    if (error instanceof PersistenceFailedError)
      return reply.code(503).send({
        code: 'PERSISTENCE_FAILURE',
        message: 'The operation could not be persisted',
      });
    return reply.code(500).send({
      code: 'SERVER_ERROR',
      message: 'Internal server error',
    });
  });
  const closePlayerConnections = (
    gameId: string,
    playerId: PlayerId,
    reason: string,
  ) => {
    connections.closePlayer(gameId, playerId, reason);
  };

  void server.register(cookie);
  void server.register(websocket, {
    options: { maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES },
  });
  if (options.onClose) server.addHook('onClose', options.onClose);
  server.get('/health', () => ({ status: 'ok' }));
  server.get('/api/bootstrap', (request) => ({
    protocolVersion: PROTOCOL_VERSION,
    transportClass: transportClass(request),
    encrypted: request.protocol === 'https',
    websocketPathTemplate: '/api/games/{gameId}/live',
  }));

  if (store && auth && games && lifecycle) {
    const requireOrigin = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (!hasValidOrigin(request, options.publicOrigin))
        return reply
          .code(403)
          .send({ code: 'UNAUTHORIZED', message: 'Invalid request origin' });
    };
    const adminToken = (request: FastifyRequest) =>
      readSessionCookie(
        request.cookies,
        { kind: 'admin' },
        transportClass(request),
      );
    const playerToken = (request: FastifyRequest, gameId: string) =>
      readSessionCookie(
        request.cookies,
        { kind: 'player', gameId },
        transportClass(request),
      );
    const setSession = (
      reply: FastifyReply,
      authority:
        | { readonly kind: 'admin' }
        | { readonly kind: 'player'; readonly gameId: string },
      token: string,
      request: FastifyRequest,
    ) => {
      const cookieValue = createSessionCookie(
        authority,
        token,
        transportClass(request),
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      );
      reply.setCookie(cookieValue.name, cookieValue.value, cookieValue.options);
    };
    const hasAdminAuthority = async (request: FastifyRequest) => {
      const token = adminToken(request);
      if (token === undefined) return false;
      const address = addressKey(request.ip);
      if (!rateLimiter.consume('host-check', address, address))
        throw new HostCheckLimitedError();
      const valid = await auth.authenticateAdmin(
        token,
        transportClass(request),
      );
      if (valid) rateLimiter.refund('host-check', address, address);
      return valid;
    };
    const consumeHttpLimit = (
      request: FastifyRequest,
      reply: FastifyReply,
      surface: 'join' | 'seat-claim',
      target: string,
    ) => {
      if (rateLimiter.consume(surface, addressKey(request.ip), target))
        return true;
      void reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many attempts; try again later',
      });
      return false;
    };
    // Every login attempt waits out its address's earlier failures first.
    const loginAllowed = (request: FastifyRequest, reply: FastifyReply) => {
      const waitMs = loginBackoff.begin(addressKey(request.ip));
      if (waitMs === 0) return true;
      void reply
        .code(429)
        .header('Retry-After', String(Math.ceil(waitMs / 1000)))
        .send({
          code: 'RATE_LIMITED',
          message: 'Too many attempts; try again later',
        });
      return false;
    };
    const loggedIn = (request: FastifyRequest) =>
      loginBackoff.succeed(addressKey(request.ip));
    const broadcastCurrentGame = async (gameId: string) => {
      try {
        await coordinator.run(gameId, async () => {
          const durable = await store.loadGame(gameId);
          if (!durable) return;
          for (const connection of connections.forGame(gameId)) {
            if (
              !auth.isPlayerAuthorityValid(
                durable,
                connection.playerId,
                connection.token,
                connection.transportClass,
              )
            ) {
              connections.closePlayer(
                gameId,
                connection.playerId,
                'SESSION_REVOKED',
              );
              continue;
            }
            if (
              !connections.send(gameId, connection, {
                type: 'STATE',
                protocolVersion: PROTOCOL_VERSION,
                state: projectGameFor(
                  durable.state,
                  durable.revision,
                  connection.playerId,
                ),
              })
            )
              server.log.warn(
                { gameId, playerId: connection.playerId },
                'WebSocket state delivery failed',
              );
          }
        });
      } catch (error) {
        server.log.error({ err: error, gameId }, 'Game broadcast failed');
      }
    };

    const sendCurrentGameTo = async (
      gameId: string,
      connection: LiveConnection,
    ) => {
      await coordinator.run(gameId, async () => {
        const durable = await store.loadGame(gameId);
        if (!durable) return;
        if (
          !auth.isPlayerAuthorityValid(
            durable,
            connection.playerId,
            connection.token,
            connection.transportClass,
          )
        ) {
          connections.closePlayer(
            gameId,
            connection.playerId,
            'SESSION_REVOKED',
          );
          return;
        }
        connections.send(gameId, connection, {
          type: 'STATE',
          protocolVersion: PROTOCOL_VERSION,
          state: projectGameFor(
            durable.state,
            durable.revision,
            connection.playerId,
          ),
        });
      });
    };

    const timedGames = new Set<string>();
    let timerBusy = false;
    let closingClocks = false;
    let clockTimer: ReturnType<typeof setInterval> | undefined;
    const runClocks = async () => {
      if (timerBusy || closingClocks) return;
      timerBusy = true;
      try {
        for (const id of timedGames) {
          try {
            if (await games.tick(id)) await broadcastCurrentGame(id);
          } catch (error) {
            server.log.error(
              { err: error, gameId: id },
              'Competitive clock persistence failed',
            );
          }
        }
      } finally {
        timerBusy = false;
      }
    };
    server.addHook('onReady', async () => {
      const discovered = await store.discoverGames();
      for (const [id, durable] of discovered.games)
        if (
          // Classic without Express still ticks while a bot plays a seat.
          (hasGameClock(durable.state) ||
            durable.state.players.some((p) => p.bot)) &&
          durable.state.status !== 'LOBBY' &&
          (durable.state.status !== 'FINISHED' ||
            durable.state.pendingInheritance)
        ) {
          timedGames.add(id);
          await games.recoverClock(id);
        }
      if ((options.clockIntervalMs ?? 1000) > 0) {
        clockTimer = setInterval(
          () => void runClocks(),
          options.clockIntervalMs ?? 1000,
        );
        clockTimer.unref();
      }
    });
    server.addHook('preClose', async () => {
      closingClocks = true;
      if (clockTimer) clearInterval(clockTimer);
      for (const id of timedGames) {
        try {
          await games.freezeClock(id);
        } catch (error) {
          server.log.error(
            { err: error, gameId: id },
            'Shutdown clock checkpoint could not be committed; preserving last confirmed state',
          );
        }
      }
      connections.closeAll();
    });
    server.post(
      '/api/admin/games/:gameId/pause',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gameIdParamsSchema.safeParse(request.params);
        const body = z
          .strictObject({ paused: z.boolean() })
          .safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        try {
          const revision = await games.pause(
            params.data.gameId,
            body.data.paused,
          );
          await broadcastCurrentGame(params.data.gameId);
          server.log.info(
            { gameId: params.data.gameId, paused: body.data.paused },
            'Administrator changed technical pause',
          );
          return { revision };
        } catch (error) {
          // Only known codes reach the page; anything else stays in the log.
          const code =
            error instanceof Error &&
            ['GAME_NOT_FOUND', 'PLAYERS_UNAVAILABLE'].includes(error.message)
              ? error.message
              : 'INVALID_PHASE';
          if (
            code === 'INVALID_PHASE' &&
            error instanceof Error &&
            error.message !== code
          )
            server.log.warn({ err: error }, 'Technical pause failed');
          return reply.code(409).send({ code });
        }
      },
    );

    const updateBots = async (
      reply: FastifyReply,
      gameId: string,
      change: Parameters<GameService['updateBots']>[1],
    ) => {
      try {
        const revision = await games.updateBots(gameId, change);
        timedGames.add(gameId);
        await broadcastCurrentGame(gameId);
        return { revision };
      } catch (error) {
        const code =
          error instanceof Error && error.message === 'GAME_NOT_FOUND'
            ? 'GAME_NOT_FOUND'
            : 'INVALID_PHASE';
        if (code === 'INVALID_PHASE')
          server.log.warn({ err: error }, 'Bot change failed');
        return reply.code(code === 'GAME_NOT_FOUND' ? 404 : 409).send({ code });
      }
    };
    server.patch(
      '/api/admin/games/:gameId/bots',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gameIdParamsSchema.safeParse(request.params);
        const body = configureBotsBodySchema.safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        return updateBots(reply, params.data.gameId, {
          ...(body.data.level ? { level: body.data.level } : {}),
          ...(body.data.replaceAbsent !== undefined
            ? { replaceAbsent: body.data.replaceAbsent }
            : {}),
        });
      },
    );
    server.post(
      '/api/admin/games/:gameId/players/:playerId/bot',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gamePlayerParamsSchema.safeParse(request.params);
        const body = assignBotBodySchema.safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        const result = await updateBots(reply, params.data.gameId, {
          playerId: params.data.playerId,
          enabled: body.data.enabled,
        });
        server.log.info(
          { gameId: params.data.gameId, enabled: body.data.enabled },
          'Administrator changed a bot seat',
        );
        return result;
      },
    );
    server.post(
      '/api/admin/games/:gameId/players/:playerId/inactive',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gamePlayerParamsSchema.safeParse(request.params);
        const body = assignBotBodySchema.safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        const result = await updateBots(reply, params.data.gameId, {
          playerId: params.data.playerId,
          inactive: body.data.enabled,
        });
        server.log.info(
          { gameId: params.data.gameId, inactive: body.data.enabled },
          'Administrator changed an inactive player',
        );
        return result;
      },
    );

    server.post(
      '/api/admin/launch',
      { bodyLimit: 256 },
      async (request, reply) => {
        const launch = options.adminLaunch;
        const parsed = adminLaunchBodySchema.safeParse(request.body);
        if (
          !launch ||
          options.publicOrigin ||
          options.trustedProxy ||
          !isLoopback(request.raw.socket.remoteAddress) ||
          request.headers.origin !== launch.origin ||
          request.headers.host !== new URL(launch.origin).host ||
          Object.keys(request.headers).some(
            (key) => key === 'forwarded' || key.startsWith('x-forwarded-'),
          )
        )
          return reply.code(403).send({ code: 'UNAUTHORIZED' });
        if (!parsed.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!loginAllowed(request, reply)) return;
        const code = launch.consume(parsed.data.token);
        if (!code) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        const token = await auth.loginAdmin(code, transportClass(request));
        if (!token) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        loggedIn(request);
        setSession(reply, { kind: 'admin' }, token, request);
        return { authenticated: true };
      },
    );

    server.post(
      '/api/admin/login',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const parsed = adminLoginBodySchema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!loginAllowed(request, reply)) return;
        const token = await auth.loginAdmin(
          parsed.data.recoveryCode,
          transportClass(request),
        );
        if (!token) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        loggedIn(request);
        setSession(reply, { kind: 'admin' }, token, request);
        return { authenticated: true };
      },
    );

    server.post(
      '/api/admin/logout',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const token = adminToken(request);
        if (token) await auth.logoutAdmin(token, transportClass(request));
        const cleared = clearSessionCookie(
          { kind: 'admin' },
          transportClass(request),
        );
        reply.setCookie(cleared.name, cleared.value, cleared.options);
        return reply.code(204).send();
      },
    );

    server.post(
      '/api/admin/games',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const parsed = createGameBodySchema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({
            code: 'MALFORMED_MESSAGE',
            message:
              'Invalid creation request; supported definition: classic / classic / rules 1',
          });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        const gameId = await lifecycle.create(
          parsed.data.configuredPlayerCount as 2 | 3 | 4 | 5 | 6,
          parsed.data.mode,
          parsed.data.definition,
        );
        return reply.code(201).send({ gameId, revision: 0 });
      },
    );

    server.get('/api/admin/connections', async (request, reply) => {
      if (!(await hasAdminAuthority(request)))
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      const listening = server.server.address();
      const address =
        listening && typeof listening !== 'string' ? listening : undefined;
      return connectionOptions(
        address?.address ?? options.connectionBind ?? '127.0.0.1',
        address?.port ?? options.connectionPort ?? 3000,
        options.publicOrigin,
      );
    });

    server.get('/api/admin/games', async (request, reply) => {
      if (!(await hasAdminAuthority(request)))
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      const discovery = await store.discoverGames();
      return reply.send({
        games: [...discovery.games.values()].map((game) =>
          projectGameForAdmin(game.state, game.revision),
        ),
        // Only the host sees it; no page or header names the version.
        version: APPLICATION_VERSION,
      });
    });

    server.get('/api/admin/games/:gameId/state', async (request, reply) => {
      const params = gameIdParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
      if (!(await hasAdminAuthority(request)))
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      return coordinator.run(params.data.gameId, async () => {
        const durable = await store.loadGame(params.data.gameId);
        if (!durable) return reply.code(404).send({ code: 'GAME_NOT_FOUND' });
        return reply.send({
          state: projectGameForAdmin(durable.state, durable.revision),
        });
      });
    });

    server.patch(
      '/api/admin/games/:gameId',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gameIdParamsSchema.safeParse(request.params);
        const body = updateGameConfigurationBodySchema.safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        const revision = await lifecycle.configure(
          params.data.gameId,
          body.data.configuredPlayerCount as 2 | 3 | 4 | 5 | 6,
          body.data.competitiveDurationMinutes,
          body.data.competitiveBotSeats,
          body.data.competitiveDeciding,
          body.data.classicExpress,
        );
        await broadcastCurrentGame(params.data.gameId);
        return { gameId: params.data.gameId, revision };
      },
    );

    server.post(
      '/api/admin/games/:gameId/start',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gameIdParamsSchema.safeParse(request.params);
        if (!params.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        const revision = await lifecycle.start(params.data.gameId);
        timedGames.add(params.data.gameId);
        await broadcastCurrentGame(params.data.gameId);
        return { gameId: params.data.gameId, revision };
      },
    );

    server.post(
      '/api/games/:gameId/join',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gameIdParamsSchema.safeParse(request.params);
        const body = joinGameBodySchema.safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!consumeHttpLimit(request, reply, 'join', params.data.gameId))
          return;
        const player: PlayerState = {
          id: randomUUID() as PlayerId,
          // AuthenticationService assigns the authoritative seat under lock.
          seatIndex: 0,
          nickname: body.data.nickname,
          color: body.data.color,
          controller: 'controlled',
          eliminated: false,
          cards: [],
          completedExchangeCount: 0,
        };
        const credentials = await auth.joinPlayer(
          params.data.gameId,
          player,
          transportClass(request),
          playerToken(request, params.data.gameId),
        );
        setSession(
          reply,
          { kind: 'player', gameId: params.data.gameId },
          credentials.sessionToken,
          request,
        );
        await broadcastCurrentGame(params.data.gameId);
        return reply.code(201).send({
          playerId: player.id,
        });
      },
    );

    server.get('/api/games/:gameId/entry', async (request, reply) => {
      const params = gameIdParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
      if (!consumeHttpLimit(request, reply, 'join', params.data.gameId)) return;
      const durable = await store.loadGame(params.data.gameId);
      if (!durable) return reply.code(404).send({ code: 'GAME_NOT_FOUND' });
      return {
        status: durable.state.status,
        canJoin:
          durable.state.status === 'LOBBY' &&
          durable.state.players.length < humanSeats(durable.state),
        availableColors: [
          'blue',
          'red',
          'black',
          'yellow',
          'green',
          'magenta',
        ].filter(
          (color) =>
            !durable.state.players.some((player) => player.color === color),
        ),
        seats: durable.state.players
          .filter(({ id, controller }) => {
            const record = durable.auth.players[id];
            return (
              controller === 'controllerless_reassignment' &&
              record &&
              !record.claim &&
              !record.session &&
              !record.recovery
            );
          })
          .map(({ id, nickname, color, seatIndex }) => ({
            id,
            nickname,
            color,
            seatIndex,
          })),
      };
    });

    server.post(
      '/api/games/:gameId/take-seat',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gameIdParamsSchema.safeParse(request.params);
        const body = takeSeatBodySchema.safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!consumeHttpLimit(request, reply, 'seat-claim', params.data.gameId))
          return;
        const existingToken = playerToken(request, params.data.gameId);
        const durable = await store.loadGame(params.data.gameId);
        if (
          existingToken &&
          durable?.state.players.some(({ id }) =>
            auth.isPlayerAuthorityValid(
              durable,
              id,
              existingToken,
              transportClass(request),
            ),
          )
        )
          return reply.code(409).send({ code: 'INVALID_GAME_COMMAND' });
        const token = await auth.takeAvailableSeat(
          params.data.gameId,
          body.data.playerId as PlayerId,
          transportClass(request),
          existingToken,
          body.data.nickname,
        );
        if (!token)
          return reply.code(409).send({ code: 'INVALID_GAME_COMMAND' });
        setSession(
          reply,
          { kind: 'player', gameId: params.data.gameId },
          token,
          request,
        );
        await broadcastCurrentGame(params.data.gameId);
        return { authenticated: true, playerId: body.data.playerId };
      },
    );

    server.post(
      '/api/games/:gameId/leave',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gameIdParamsSchema.safeParse(request.params);
        if (!params.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        const token = playerToken(request, params.data.gameId);
        if (!token) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        const durable = await store.loadGame(params.data.gameId);
        const player = durable?.state.players.find(({ id }) =>
          auth.isPlayerAuthorityValid(
            durable,
            id,
            token,
            transportClass(request),
          ),
        );
        if (
          !player ||
          !(await auth.releasePlayer(
            params.data.gameId,
            token,
            transportClass(request),
          ))
        )
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        closePlayerConnections(
          params.data.gameId,
          player.id,
          'SESSION_REVOKED',
        );
        const cleared = clearSessionCookie(
          { kind: 'player', gameId: params.data.gameId },
          transportClass(request),
        );
        reply.setCookie(cleared.name, cleared.value, cleared.options);
        await broadcastCurrentGame(params.data.gameId);
        return reply.code(204).send();
      },
    );

    server.delete(
      '/api/admin/games/:gameId/players/:playerId',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gamePlayerParamsSchema.safeParse(request.params);
        if (!params.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        const removed = await auth.leaveLobbySeat(
          params.data.gameId,
          params.data.playerId as PlayerId,
        );
        if (!removed)
          throw new AuthenticationOperationError('PLAYER_NOT_FOUND');
        closePlayerConnections(
          params.data.gameId,
          params.data.playerId as PlayerId,
          'SESSION_REVOKED',
        );
        await broadcastCurrentGame(params.data.gameId);
        return reply.code(204).send();
      },
    );

    server.delete(
      '/api/admin/games/:gameId',
      { preHandler: requireOrigin },
      async (request, reply) => {
        const params = gameIdParamsSchema.safeParse(request.params);
        const body = confirmGameActionBodySchema.safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
        if (body.data.confirmGameId !== params.data.gameId)
          return reply.code(409).send({ code: 'INVALID_GAME_COMMAND' });
        if (!(await hasAdminAuthority(request)))
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        await lifecycle.delete(params.data.gameId);
        connections.closeGame(params.data.gameId, 'GAME_DELETED');
        timedGames.delete(params.data.gameId);
        return reply.code(204).send();
      },
    );

    server.get('/api/games/:gameId/state', async (request, reply) => {
      const params = gameIdParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ code: 'MALFORMED_MESSAGE' });
      const token = playerToken(request, params.data.gameId);
      if (!token) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      const effectiveTransport = transportClass(request);
      return coordinator.run(params.data.gameId, async () => {
        const durable = await store.loadGame(params.data.gameId);
        if (!durable) return reply.code(404).send({ code: 'GAME_NOT_FOUND' });
        const player = durable.state.players.find(({ id }) =>
          auth.isPlayerAuthorityValid(durable, id, token, effectiveTransport),
        );
        if (!player) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        return reply.send({
          protocolVersion: PROTOCOL_VERSION,
          state: projectGameFor(durable.state, durable.revision, player.id),
        });
      });
    });

    server.after(() => {
      server.get(
        '/api/games/:gameId/live',
        { websocket: true },
        async (socket, request) => {
          const params = gameIdParamsSchema.safeParse(request.params);
          const protocols = request.headers['sec-websocket-protocol']
            ?.split(',')
            .map((value) => value.trim());
          if (
            !params.success ||
            !hasValidOrigin(request, options.publicOrigin) ||
            !protocols?.includes(`classic-v${PROTOCOL_VERSION}`)
          ) {
            socket.close(
              1008,
              !params.success
                ? 'UNAUTHORIZED'
                : protocols?.includes(`classic-v${PROTOCOL_VERSION}`)
                  ? 'UNAUTHORIZED'
                  : 'PROTOCOL_MISMATCH',
            );
            return;
          }
          const token = playerToken(request, params.data.gameId);
          if (!token) {
            socket.close(1008, 'UNAUTHORIZED');
            return;
          }
          const effectiveTransport = transportClass(request);
          const established = await coordinator.run(
            params.data.gameId,
            async () => {
              const durable = await store.loadGame(params.data.gameId);
              if (!durable) return undefined;
              const player = durable.state.players.find(({ id }) =>
                auth.isPlayerAuthorityValid(
                  durable,
                  id,
                  token,
                  effectiveTransport,
                ),
              );
              if (!player) return undefined;
              // Bound passive clock/state fanout as well as command traffic.
              if (
                connections
                  .forGame(params.data.gameId)
                  .filter((c) => c.playerId === player.id).length >= 8
              ) {
                socket.send(
                  JSON.stringify({
                    type: 'ERROR',
                    protocolVersion: PROTOCOL_VERSION,
                    code: 'RATE_LIMITED',
                    message:
                      'Too many simultaneous connections for this player; close another tab',
                  }),
                );
                socket.close(1008, 'RATE_LIMITED');
                return undefined;
              }
              const connection: LiveConnection = {
                socket,
                playerId: player.id,
                token,
                transportClass: effectiveTransport,
              };
              if (!connections.register(params.data.gameId, connection))
                return undefined;
              if (
                !connections.send(params.data.gameId, connection, {
                  type: 'HELLO',
                  protocolVersion: PROTOCOL_VERSION,
                  gameId: params.data.gameId,
                  playerId: player.id,
                })
              )
                return undefined;
              if (
                !connections.send(params.data.gameId, connection, {
                  type: 'STATE',
                  protocolVersion: PROTOCOL_VERSION,
                  state: projectGameFor(
                    durable.state,
                    durable.revision,
                    player.id,
                  ),
                })
              )
                return undefined;
              return connection;
            },
          );
          if (!established) {
            if (socket.readyState === socket.OPEN)
              socket.close(1008, 'UNAUTHORIZED');
            return;
          }
          const connection = established;
          const { playerId } = connection;
          const handleMessage = async (data: RawData) => {
            if (
              !rateLimiter.consume(
                'game-command',
                `${params.data.gameId}:${playerId}`,
                params.data.gameId,
                'session',
              )
            ) {
              connections.send(params.data.gameId, connection, {
                type: 'ERROR',
                protocolVersion: PROTOCOL_VERSION,
                code: 'RATE_LIMITED',
                message: 'Too many commands; reconnect and try again later',
              });
              socket.close(1008, 'RATE_LIMITED');
              return;
            }
            const bytes = Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);
            const messageBytes = bytes.byteLength;
            if (messageBytes > MAX_WEBSOCKET_MESSAGE_BYTES) {
              socket.close(1009, 'MESSAGE_TOO_LARGE');
              return;
            }
            let decoded: unknown;
            try {
              decoded = JSON.parse(bytes.toString('utf8'));
            } catch {
              decoded = undefined;
            }
            const parsed = clientCommandSchema.safeParse(decoded);
            if (!parsed.success) {
              const incompatibleVersion =
                typeof decoded === 'object' &&
                decoded !== null &&
                'protocolVersion' in decoded &&
                decoded.protocolVersion !== PROTOCOL_VERSION;
              const withinLimit = rateLimiter.consume(
                'protocol-abuse',
                `${params.data.gameId}:${playerId}`,
                params.data.gameId,
                'session',
              );
              connections.send(params.data.gameId, connection, {
                type: 'ERROR',
                protocolVersion: PROTOCOL_VERSION,
                code: !withinLimit
                  ? 'RATE_LIMITED'
                  : incompatibleVersion
                    ? 'PROTOCOL_MISMATCH'
                    : 'MALFORMED_MESSAGE',
                message: !withinLimit
                  ? 'Too many invalid messages; try again later'
                  : incompatibleVersion
                    ? 'Client protocol version is incompatible with this server'
                    : 'Malformed command message',
              });
              if (!withinLimit) socket.close(1008, 'RATE_LIMITED');
              return;
            }
            const outcome = await games.process(
              params.data.gameId,
              playerId,
              parsed.data,
              (durable) =>
                auth.isPlayerAuthorityValid(
                  durable,
                  playerId,
                  token,
                  effectiveTransport,
                ),
            );
            if (outcome.kind === 'COMMITTED' || outcome.kind === 'DUPLICATE') {
              connections.send(params.data.gameId, connection, {
                type: 'COMMAND_RESULT',
                protocolVersion: PROTOCOL_VERSION,
                commandId: parsed.data.commandId,
                status: outcome.kind,
                committedRevision: outcome.revision,
              });
              if (outcome.kind === 'COMMITTED')
                await broadcastCurrentGame(params.data.gameId);
              return;
            }
            if ('code' in outcome && outcome.code === 'STALE_REVISION') {
              if (outcome.stateChanged)
                await broadcastCurrentGame(params.data.gameId);
              else await sendCurrentGameTo(params.data.gameId, connection);
            }
            if ('code' in outcome && outcome.code === 'UNAUTHORIZED') {
              socket.close(1008, 'SESSION_REVOKED');
              return;
            }
            if (!('code' in outcome)) return;
            connections.send(params.data.gameId, connection, {
              type: 'COMMAND_REJECTED',
              protocolVersion: PROTOCOL_VERSION,
              commandId: parsed.data.commandId,
              code: protocolErrorCodeSchema.parse(outcome.code),
              message: outcome.message,
              ...('revision' in outcome && outcome.revision !== undefined
                ? { currentRevision: outcome.revision }
                : {}),
            });
          };
          let queuedMessages = 0;
          socket.on('message', (data: RawData) => {
            if (queuedMessages >= 8) {
              socket.close(1008, 'RATE_LIMITED');
              return;
            }
            queuedMessages++;
            void handleMessage(data)
              .catch((error: unknown) => {
                server.log.error(
                  { err: error, gameId: params.data.gameId },
                  'Command processing failed',
                );
                socket.close(1011, 'COMMAND_FAILED');
              })
              .finally(() => {
                queuedMessages--;
              });
          });
        },
      );
    });
  }

  const webRoot = resolve(options.webRoot ?? 'apps/web/dist');
  if (existsSync(webRoot)) {
    void server.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      // The build leaves .br and .gz copies next to each text file.
      preCompressed: true,
      cacheControl: false,
      setHeaders: (response, path) => {
        // Files under assets/ carry a content hash in their name and never change.
        void response.header(
          'Cache-Control',
          /[\\/]assets[\\/]/.test(path)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    });
    server.get('/admin', (_request, reply) => reply.sendFile('index.html'));
    server.get('/game/:gameId', (request, reply) => {
      if (!gameIdParamsSchema.safeParse(request.params).success)
        return reply.code(404).send({ code: 'GAME_NOT_FOUND' });
      return reply.sendFile('index.html');
    });
    // The how-to-play pages are a copy of the project site without its home
    // pages; their "home" links lead back to this server's start page.
    for (const path of [
      '/como-jugar',
      '/como-jugar/',
      '/como-jugar/index.html',
      '/como-jugar/en',
      '/como-jugar/en/',
      '/como-jugar/en/index.html',
    ])
      server.get(path, (_request, reply) => reply.redirect('/'));
  }
  return server;
}
