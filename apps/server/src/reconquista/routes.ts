/** Reconquista routes: same data folder, admin session and origin rules as Classic. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import {
  preparationBoard,
  projectReconquistaSession,
  reconquistaExpressDurationMs,
  validateReconquistaCatalog,
} from '@game/game-engine/reconquista';
import {
  RECONQUISTA_PROTOCOL,
  RECONQUISTA_DEFINITION,
  reconquistaViewSchema,
  reconquistaBoardSchema,
  reconquistaCommandSchema,
  reconquistaFocusSchema,
  reconquistaCreateSchema,
  type ReconquistaView,
} from '@game/protocol/reconquista';
import {
  ReconquistaStore,
  ReconquistaOperationError,
  type ReconquistaEnvelope,
} from './store.js';
import { AuthenticationService } from '../auth/authentication.js';
import type { FileGameStore } from '../persistence/file-game-store.js';
import { readSessionCookie, createSessionCookie } from '../auth/cookies.js';
import {
  addressKey,
  LayeredRateLimiter,
  type RateLimitPolicy,
  type RateLimitSurface,
} from '../security/rate-limiter.js';
import { hasValidOrigin } from '../security/origin.js';
import {
  PersistenceFailedError,
  PersistenceIndeterminateError,
  type AtomicWriteOptions,
} from '../persistence/atomic-file.js';
const gameParams = z.strictObject({ gameId: z.string().uuid() });
const prefix = '/api/reconquista';
const MAX_LIVE_PER_GAME = 24;
/** Tabs one seat (or the host) may keep listening at once. */
const MAX_LIVE_PER_VIEWER = 4;
/** Shared selections are announced at most this often per game. */
const FOCUS_ANNOUNCE_MS = 150;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
/** Content that never changes while the server runs, compressed once at start. */
function packed(text: string, type: string) {
  const raw = Buffer.from(text);
  return {
    type,
    raw,
    br: brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      },
    }),
    gzip: gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }),
    etag: `"${digest(text).slice(0, 32)}"`,
  };
}
function sendPacked(
  request: FastifyRequest,
  reply: FastifyReply,
  content: ReturnType<typeof packed>,
) {
  void reply
    .header('Cache-Control', 'no-cache')
    .header('ETag', content.etag)
    .header('Vary', 'Accept-Encoding')
    .type(content.type);
  if (request.headers['if-none-match'] === content.etag)
    return reply.code(304).send();
  const accepted = String(request.headers['accept-encoding'] ?? '');
  const encoding = /\bbr\b/.test(accepted)
    ? 'br'
    : /\bgzip\b/.test(accepted)
      ? 'gzip'
      : undefined;
  if (!encoding) return reply.send(content.raw);
  return reply.header('Content-Encoding', encoding).send(content[encoding]);
}
const colorNames: Record<string, string> = {
  red: 'rojo',
  white: 'blanco',
  blue: 'azul',
  black: 'negro',
  green: 'verde',
  yellow: 'amarillo',
};
const colorNamesEn: Record<string, string> = {
  red: 'red',
  white: 'white',
  blue: 'blue',
  black: 'black',
  green: 'green',
  yellow: 'yellow',
};
const continentNamesEn: Record<string, string> = {
  north_america: 'North America',
  central_america: 'Central America',
  south_america: 'South America',
  europe: 'Europe',
  asia: 'Asia',
  africa: 'Africa',
  oceania: 'Oceania',
};
const continentNames: Record<string, string> = {
  north_america: 'América del Norte',
  central_america: 'América Central',
  south_america: 'América del Sur',
  europe: 'Europa',
  asia: 'Asia',
  africa: 'África',
  oceania: 'Oceanía',
};
/** The release keeps the assets next to server.mjs; a checkout reads them from apps/server/assets. */
function reconquistaAssetsDirectory(): string {
  const packaged = join(import.meta.dirname, 'assets/reconquista');
  return existsSync(packaged)
    ? packaged
    : resolve(import.meta.dirname, '../../assets/reconquista');
}
export async function loadReconquistaAssets(
  art: string = reconquistaAssetsDirectory(),
) {
  const catalog: unknown = JSON.parse(
    await readFile(join(art, 'catalog.json'), 'utf8'),
  );
  validateReconquistaCatalog(catalog);
  const authority = z
    .object({
      id: z.literal('ted-reconquista-board-visual-3'),
      approvedFilesSha256: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(await readFile(join(art, 'authority.json'), 'utf8')));
  const approved = async (name: string) => {
    const text = await readFile(join(art, name), 'utf8');
    if (digest(text) !== authority.approvedFilesSha256[name])
      throw new Error('Authoritative Reconquista map mismatch');
    return text;
  };
  const light = await approved('reconquista-map-v8.svg');
  const dark = await approved('reconquista-map-v8-dark.svg');
  // The game page's style-src is 'self': inline styles in the art would be blocked.
  if (/<style|style=/.test(light + dark))
    throw new Error('Reconquista map art must not carry inline styles');
  const labels = z
    .record(z.string(), z.tuple([z.number(), z.number()]))
    .parse(JSON.parse(await approved('labels.json')));
  const missileSpots = z
    .record(z.string(), z.array(z.tuple([z.number(), z.number(), z.number()])))
    .parse(JSON.parse(await approved('missile-spots.json')));
  const raw = z
    .object({
      territories: z.array(
        z.object({ id: z.string(), name: z.string(), continentId: z.string() }),
      ),
      connections: z.array(
        z.object({ endpoints: z.tuple([z.string(), z.string()]) }),
      ),
      objectives: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(['occupation', 'destruction']),
          target: z.string().optional(),
          requirements: z
            .record(z.string(), z.union([z.number(), z.literal('all')]))
            .optional(),
          minTerritories: z.number().optional(),
          islands: z
            .object({ count: z.number(), minContinents: z.number() })
            .optional(),
        }),
      ),
    })
    .parse(catalog);
  const board = reconquistaBoardSchema.parse({
    protocolVersion: 1,
    authorityId: authority.id,
    countries: raw.territories.map((c) => ({
      ...c,
      label: labels[c.id],
      missileSpots: missileSpots[c.id],
    })),
    connections: raw.connections.map((c) => c.endpoints),
  });
  // Wording follows the printed objective list: "Ocupar Asia y América Central."
  const describe = (o: (typeof raw.objectives)[number], en: boolean) => {
    const names = en ? continentNamesEn : continentNames;
    const listed = (parts: readonly string[]) =>
      parts.length > 1
        ? `${parts.slice(0, -1).join(', ')} ${en ? 'and' : 'y'} ${parts.at(-1)}`
        : (parts[0] ?? '');
    const spelled: Record<number, string> = en
      ? { 2: 'two', 3: 'three', 4: 'four' }
      : { 2: 'dos', 3: 'tres', 4: 'cuatro' };
    if (o.kind === 'destruction') {
      if (o.target === 'left_neighbor')
        return en
          ? 'Destroy the player on your left.'
          : 'Destruir al jugador de la izquierda.';
      const color = (
        (en ? colorNamesEn : colorNames)[o.target!] ?? o.target!
      ).replace(/^./, (c) => c.toUpperCase());
      return en
        ? `Destroy the ${color} army.`
        : `Destruir al ejército ${color}.`;
    }
    if (o.minTerritories)
      return en
        ? `Occupy ${o.minTerritories} countries anywhere on the map.`
        : `Ocupar ${o.minTerritories} países en cualquier lugar del mapa.`;
    const entries = Object.entries(o.requirements ?? {});
    const whole = entries
      .filter(([, n]) => n === 'all')
      .map(([id]) => names[id]!);
    const counted = entries
      .filter(([, n]) => n !== 'all')
      .map(([id, n], i) =>
        en
          ? i === 0
            ? `${n} countries in ${names[id]}`
            : `${n} in ${names[id]}`
          : i === 0
            ? `${n} países de ${names[id]}`
            : `${n} de ${names[id]}`,
      );
    const continents =
      o.islands &&
      (spelled[o.islands.minContinents] ?? o.islands.minContinents);
    const islands = o.islands
      ? [
          en
            ? `${o.islands.count} islands, spread over at least ${continents} continents`
            : `${o.islands.count} islas, repartidas en por lo menos ${continents} continentes`,
        ]
      : [];
    return `${en ? 'Occupy' : 'Ocupar'} ${listed([...whole, ...counted, ...islands])}.`;
  };
  const descriptions = new Map(
    raw.objectives.map((o) => [
      o.id,
      { es: describe(o, false), en: describe(o, true) },
    ]),
  );
  return { catalog, board, light, dark, descriptions };
}
export async function registerReconquista(
  server: FastifyInstance,
  options: {
    readonly assetsDirectory?: string;
    readonly dataDirectory: string;
    readonly publicOrigin?: string;
    readonly classicStore: FileGameStore;
    readonly randomness?: () => number;
    /** Tests drive the Express clock by hand. */
    readonly clockTicks?: boolean;
    readonly writeOptions?: AtomicWriteOptions;
    readonly rateLimitPolicies?: Readonly<
      Record<RateLimitSurface, RateLimitPolicy>
    >;
  },
) {
  const assets = await loadReconquistaAssets(options.assetsDirectory);
  const board = preparationBoard(assets.catalog);
  const store = await ReconquistaStore.open(
    join(options.dataDirectory, 'reconquista'),
    assets.catalog,
    options.writeOptions,
    options.randomness,
  );
  const auth = new AuthenticationService(options.classicStore);
  const packedBoard = packed(
    JSON.stringify(assets.board),
    'application/json; charset=utf-8',
  );
  const packedArt = {
    light: packed(assets.light, 'image/svg+xml'),
    dark: packed(assets.dark, 'image/svg+xml'),
  };
  const limiter = new LayeredRateLimiter(options.rateLimitPolicies);
  const transport = (r: FastifyRequest) =>
    r.protocol === 'https' ? ('HTTPS' as const) : ('HTTP' as const);
  const playerToken = (r: FastifyRequest, id: string) =>
    readSessionCookie(
      r.cookies,
      { kind: 'player', gameId: 'reconquista-' + id },
      transport(r),
    );
  const isAdmin = async (r: FastifyRequest) => {
    const token = readSessionCookie(r.cookies, { kind: 'admin' }, transport(r));
    if (token === undefined) return false;
    const address = addressKey(r.ip);
    if (!limiter.consume('host-check', address, address))
      throw new ReconquistaOperationError('RATE_LIMITED');
    const valid = await auth.authenticateAdmin(token, transport(r));
    if (valid) limiter.refund('host-check', address, address);
    return valid;
  };
  const requireAdmin = async (r: FastifyRequest) => {
    if (!(await isAdmin(r)))
      throw new ReconquistaOperationError('UNAUTHORIZED');
  };
  const params = (r: FastifyRequest) => gameParams.parse(r.params).gameId;
  // A seat or the host counts against itself; anyone else, made-up cookies
  // included, against the address.
  const limit = async (
    r: FastifyRequest,
    surface: 'game-command' | 'game-read',
    id: string,
  ) => {
    const seat = store.seatOf(id, playerToken(r, id));
    const allowed = seat
      ? limiter.consume(surface, `${id}:${seat}`, id, 'session')
      : (await isAdmin(r))
        ? limiter.consume(surface, 'host', id, 'session')
        : limiter.consume(surface, addressKey(r.ip), id);
    if (!allowed) throw new ReconquistaOperationError('RATE_LIMITED');
  };
  // Selection shared by the player on turn: memory only, so it never reaches the journal.
  const focuses = new Map<string, NonNullable<ReconquistaView['focus']>>();
  const countryIds = new Set(board.countries.map((c) => c.id));
  const described = <T extends { objectiveId: string }>(o: T) => ({
    ...o,
    ...(o.objectiveId === 'common_45'
      ? {
          description: 'Ocupar 45 países.',
          descriptionEn: 'Occupy 45 countries.',
        }
      : {
          description: assets.descriptions.get(o.objectiveId)!.es,
          descriptionEn: assets.descriptions.get(o.objectiveId)!.en,
        }),
  });
  /** Public seats: never the session digests. */
  const seats = (current: ReconquistaEnvelope) =>
    current.players.map(({ id, color, nickname, ready, bot, free }) => ({
      id,
      color,
      nickname,
      ready,
      ...(bot ? { bot } : {}),
      ...(free ? { free } : {}),
    }));
  /** The Express clock for screens, without the server's bookkeeping. */
  const clock = (current: ReconquistaEnvelope) => {
    const c = current.clock;
    if (!c) return {};
    return {
      clock: {
        durationMs: reconquistaExpressDurationMs(current.playerCount),
        elapsedMs: c.elapsedMs,
        activationRemainingMs: c.activationRemainingMs,
        ...(c.finalRound !== undefined ? { finalRound: c.finalRound } : {}),
        ...(c.pauseReason ? { pauseReason: c.pauseReason } : {}),
        ...(c.disconnectedPlayerId
          ? { disconnectedPlayerId: c.disconnectedPlayerId }
          : {}),
        ...(c.technicalRemainingMs !== undefined
          ? { technicalRemainingMs: c.technicalRemainingMs }
          : {}),
        absentPlayerIds: c.absentPlayerIds,
      },
    };
  };
  function view(
    current: ReconquistaEnvelope,
    viewer: string | null,
  ): ReconquistaView {
    const base = {
      protocolVersion: RECONQUISTA_PROTOCOL,
      definition: RECONQUISTA_DEFINITION,
      gameId: current.gameId,
      revision: current.revision,
      playerCount: current.playerCount,
      ...(current.express ? { express: true } : {}),
      ...clock(current),
    };
    const players = seats(current);
    if (!current.journal)
      return reconquistaViewSchema.parse({
        ...base,
        players,
        stage: 'lobby',
        circle: [],
        territories: [],
        situation: null,
        crisis: null,
        restingPlayerId: null,
        hostility: null,
        campaign: null,
        ...(viewer
          ? {
              self: {
                playerId: viewer,
                objectives: [],
                legal: {
                  actorId: viewer,
                  canPlace: false,
                  canReveal: false,
                  budget: 0,
                  placementCountryIds: [],
                  missileShots: [],
                  missileRegroups: [],
                  attacks: [],
                  regroups: [],
                  transfer: null,
                },
              },
            }
          : {}),
      });
    const { state } = store.replay(current);
    const projection = projectReconquistaSession(board, state, viewer);
    const { self, ...publicView } = projection;
    // Explicit DTO construction: never spread internal state/journal/auth into the transport.
    return reconquistaViewSchema.parse({
      ...base,
      players,
      stage: publicView.stage,
      territories: publicView.territories,
      circle: publicView.circle,
      situation: publicView.situation,
      crisis: publicView.crisis,
      restingPlayerId: publicView.restingPlayerId,
      hostility: publicView.hostility,
      campaign: publicView.campaign,
      ...(focuses.has(current.gameId)
        ? { focus: focuses.get(current.gameId) }
        : {}),
      ...(publicView.winnerObjectives.length
        ? {
            winnerObjectives: publicView.winnerObjectives.map((w) => ({
              playerId: w.playerId,
              objectives: w.objectives.map(described),
            })),
          }
        : {}),
      ...(self
        ? {
            self: {
              playerId: self.playerId,
              ...(self.campaign ? { campaign: self.campaign } : {}),
              legal: self.legal,
              objectives: self.objectives.map(described),
            },
          }
        : {}),
    });
  }
  // Live connections only announce a new revision; each screen then reads its own view.
  // Each open connection remembers whose it is: a seat's player id, or 'host'.
  const live = new Map<string, Map<WebSocket, string>>();
  const notify = (gameId: string) => {
    for (const socket of live.get(gameId)?.keys() ?? [])
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: 'CHANGED' }));
  };
  // A seat taken away (or the whole game) also takes away its live connections.
  // A seat a bot plays keeps them: its person still watches and may get it back.
  const disconnect = (gameId: string, reason: string, viewer?: string) => {
    for (const [socket, owner] of live.get(gameId) ?? [])
      if (viewer === undefined || owner === viewer) socket.close(1008, reason);
  };
  // A burst of selections (arrow keys) reaches the other screens as one announcement.
  const focusTimers = new Map<string, NodeJS.Timeout>();
  const announceFocus = (gameId: string) => {
    if (focusTimers.has(gameId)) return;
    focusTimers.set(
      gameId,
      setTimeout(() => {
        focusTimers.delete(gameId);
        notify(gameId);
      }, FOCUS_ANNOUNCE_MS),
    );
  };
  // Express games run on a clock, ticked every second as Classic's.
  const ticking = new Set(await store.running());
  const connected = (gameId: string) => (playerId: string) =>
    [...(live.get(gameId)?.values() ?? [])].includes(playerId);
  let ticks = 0;
  let ticked = Promise.resolve();
  const clockTimer = setInterval(() => {
    ticked = ticked
      .then(async () => {
        // Games that ended or were removed leave the list now and then.
        if (++ticks % 30 === 0)
          for (const id of [...ticking])
            if (!(await store.running()).includes(id)) ticking.delete(id);
        for (const id of ticking)
          if (
            await store.tick(id, Date.now(), connected(id)).catch(() => false)
          )
            notify(id);
      })
      .catch(() => {});
  }, 1_000);
  clockTimer.unref();
  if (options.clockTicks === false) clearInterval(clockTimer);
  void server.register((app, _options, done) => {
    app.addHook('onClose', async () => {
      clearInterval(clockTimer);
      // A tick still reading the store would keep the lock busy on Windows.
      await ticked;
      await store.close();
    });
    app.addHook('preClose', (closed) => {
      for (const timer of focusTimers.values()) clearTimeout(timer);
      focusTimers.clear();
      for (const sockets of live.values())
        for (const socket of sockets.keys())
          socket.close(1001, 'SERVER_CLOSING');
      closed();
    });
    app.addHook('onRequest', async (request, reply) => {
      if (
        request.method !== 'GET' &&
        !hasValidOrigin(request, options.publicOrigin)
      )
        return reply.code(403).send({ code: 'UNAUTHORIZED' });
      void reply.header('Cache-Control', 'no-store');
    });
    app.setErrorHandler((error, request, reply) => {
      if (
        error instanceof PersistenceIndeterminateError ||
        error instanceof PersistenceFailedError
      ) {
        request.log.error(error, 'Reconquista request failed');
        return reply.code(503).send({
          code:
            error instanceof PersistenceIndeterminateError
              ? 'UNAVAILABLE_UNTIL_RESTART'
              : 'PERSISTENCE_FAILURE',
        });
      }
      if (error instanceof ReconquistaOperationError)
        return reply
          .code(
            error.code === 'UNAUTHORIZED'
              ? 401
              : error.code === 'RATE_LIMITED'
                ? 429
                : error.code === 'NOT_FOUND'
                  ? 404
                  : [
                        'INCOMPATIBLE_SNAPSHOT',
                        'UNAVAILABLE_UNTIL_RESTART',
                      ].includes(error.code)
                    ? 503
                    : 409,
          )
          .send({ code: error.code });
      if (error instanceof z.ZodError)
        return reply
          .code(400)
          .send({ code: 'INCOMPATIBLE_RECONQUISTA_CONTRACT' });
      // Fastify's own rejections (broken JSON, oversized or unsupported bodies).
      const status = (error as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500)
        return reply
          .code(status)
          .send({ code: 'INCOMPATIBLE_RECONQUISTA_CONTRACT' });
      // The rules reject moves with plain errors; a runtime or system error is
      // a server bug and must reach the log instead of passing as a bad move.
      if (
        error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof ReferenceError ||
        error instanceof SyntaxError ||
        (error instanceof Error && 'errno' in error)
      ) {
        request.log.error(error, 'Reconquista request failed');
        return reply.code(500).send({ code: 'SERVER_ERROR' });
      }
      return reply.code(409).send({ code: 'INVALID_RECONQUISTA_ACTION' });
    });
    app.get(prefix + '/board', (request, reply) =>
      sendPacked(request, reply, packedBoard),
    );
    app.get(prefix + '/art/:theme', (request, reply) => {
      const { theme } = z
        .strictObject({ theme: z.enum(['light', 'dark']) })
        .parse(request.params);
      return sendPacked(request, reply, packedArt[theme]);
    });
    app.get(prefix + '/games', async (request) => {
      await requireAdmin(request);
      return { games: await store.list() };
    });
    app.post(prefix + '/games', async (request) => {
      await requireAdmin(request);
      const body = reconquistaCreateSchema.parse(request.body);
      const current = await store.create(body.playerCount);
      return {
        gameId: current.gameId,
        revision: current.revision,
        protocolVersion: RECONQUISTA_PROTOCOL,
      };
    });
    app.get(prefix + '/games/:gameId/entry', async (request) => {
      await limit(request, 'game-read', params(request));
      const current = await store.load(params(request));
      return {
        playerCount: current.playerCount,
        ...(current.express ? { express: true } : {}),
        stage: current.journal ? 'started' : 'lobby',
        players: seats(current),
        ...(current.botSeats ? { botSeats: current.botSeats } : {}),
        botLevel: current.botLevel ?? 'hard',
        botsReplaceAbsent: current.botsReplaceAbsent !== false,
      };
    });
    app.post(prefix + '/games/:gameId/join', async (request, reply) => {
      const id = params(request);
      if (!limiter.consume('join', addressKey(request.ip), id))
        return reply.code(429).send({ code: 'RATE_LIMITED' });
      const current = await store.load(id);
      const existing = store.authenticate(current, playerToken(request, id));
      if (existing) return { playerId: existing };
      const result = await store.join(id, request.body);
      notify(id);
      const cookie = createSessionCookie(
        { kind: 'player', gameId: 'reconquista-' + id },
        result.token,
        transport(request),
        result.expiresAt,
      );
      reply.setCookie(cookie.name, cookie.value, cookie.options);
      return { playerId: result.playerId };
    });
    app.post(prefix + '/games/:gameId/take-seat', async (request, reply) => {
      const id = params(request);
      if (!limiter.consume('join', addressKey(request.ip), id))
        return reply.code(429).send({ code: 'RATE_LIMITED' });
      const current = await store.load(id);
      const existing = store.authenticate(current, playerToken(request, id));
      if (existing) return { playerId: existing };
      const result = await store.takeSeat(id, request.body);
      notify(id);
      const cookie = createSessionCookie(
        { kind: 'player', gameId: 'reconquista-' + id },
        result.token,
        transport(request),
        result.expiresAt,
      );
      reply.setCookie(cookie.name, cookie.value, cookie.options);
      return { playerId: result.playerId };
    });
    app.post(prefix + '/games/:gameId/ready', async (request) => {
      z.strictObject({}).parse(request.body ?? {});
      const id = params(request);
      await limit(request, 'game-command', id);
      const current = await store.ready(id, playerToken(request, id));
      notify(id);
      return view(
        current,
        store.authenticate(current, playerToken(request, id))!,
      );
    });
    app.patch(prefix + '/games/:gameId', async (request) => {
      await requireAdmin(request);
      const current = await store.configure(params(request), request.body);
      notify(current.gameId);
      return { gameId: current.gameId, revision: current.revision };
    });
    app.delete(prefix + '/games/:gameId', async (request) => {
      await requireAdmin(request);
      await store.remove(params(request));
      focuses.delete(params(request));
      disconnect(params(request), 'GAME_DELETED');
      return { deleted: true };
    });
    app.delete(prefix + '/games/:gameId/players/:playerId', async (request) => {
      await requireAdmin(request);
      const { gameId, playerId } = z
        .strictObject({
          gameId: z.string().uuid(),
          playerId: z.string().uuid(),
        })
        .parse(request.params);
      await store.removePlayer(gameId, playerId);
      disconnect(gameId, 'SESSION_REVOKED', playerId);
      notify(gameId);
      return { removed: true };
    });
    app.post(prefix + '/games/:gameId/start', async (request) => {
      await requireAdmin(request);
      z.strictObject({}).parse(request.body ?? {});
      const started = await store.start(params(request));
      if (started.express || started.players.some((p) => p.bot))
        ticking.add(started.gameId);
      notify(started.gameId);
      return view(started, null);
    });
    app.post(prefix + '/games/:gameId/bots', async (request) => {
      await requireAdmin(request);
      const current = await store.bots(
        params(request),
        request.body,
        Date.now(),
      );
      if (current.players.some((p) => p.bot)) ticking.add(current.gameId);
      notify(current.gameId);
      return view(current, null);
    });
    app.post(prefix + '/games/:gameId/pause', async (request) => {
      await requireAdmin(request);
      const { paused } = z
        .strictObject({ paused: z.boolean() })
        .parse(request.body);
      const current = await store.pause(params(request), paused, Date.now());
      notify(current.gameId);
      return view(current, null);
    });
    app.get(prefix + '/games/:gameId/state', async (request) => {
      await limit(request, 'game-read', params(request));
      const current = await store.load(params(request));
      const actor = store.authenticate(
        current,
        playerToken(request, current.gameId),
      );
      const observer =
        z.object({ observer: z.enum(['1']).optional() }).parse(request.query)
          .observer === '1';
      if (actor && !observer) return view(current, actor);
      await requireAdmin(request);
      return view(current, null);
    });
    app.post(prefix + '/games/:gameId/commands', async (request) => {
      const id = params(request);
      await limit(request, 'game-command', id);
      const command = reconquistaCommandSchema.parse(request.body);
      const result = await store.command(id, playerToken(request, id), command);
      if (!result.duplicate) notify(id);
      const actor = store.authenticate(
        result.envelope,
        playerToken(request, id),
      );
      if (!actor) throw new ReconquistaOperationError('UNAUTHORIZED');
      return {
        state: view(result.envelope, actor),
        duplicate: result.duplicate,
      };
    });
    app.post(prefix + '/games/:gameId/focus', async (request) => {
      const id = params(request);
      await limit(request, 'game-command', id);
      const { originId, targetId } = reconquistaFocusSchema.parse(request.body);
      const current = await store.load(id);
      const playerId = store.authenticate(current, playerToken(request, id));
      if (!playerId) throw new ReconquistaOperationError('UNAUTHORIZED');
      if (
        ![originId, targetId].every((c) => c === undefined || countryIds.has(c))
      )
        throw new ReconquistaOperationError('INVALID_COMMAND');
      // Only the player on turn shares a selection.
      if (
        !current.journal ||
        projectReconquistaSession(board, store.replay(current).state, playerId)
          .self?.legal.actorId !== playerId
      )
        throw new ReconquistaOperationError('NOT_YOUR_TURN');
      const focus = {
        playerId,
        ...(originId ? { originId } : {}),
        ...(targetId ? { targetId } : {}),
      };
      // Repeating the same selection announces nothing.
      if (JSON.stringify(focuses.get(id)) === JSON.stringify(focus))
        return { ok: true };
      focuses.set(id, focus);
      announceFocus(id);
      return { ok: true };
    });
    app.get(
      prefix + '/games/:gameId/live',
      { websocket: true },
      async (socket, request) => {
        const id = gameParams.safeParse(request.params);
        const current =
          id.success && hasValidOrigin(request, options.publicOrigin)
            ? await store.load(id.data.gameId).catch(() => undefined)
            : undefined;
        // Only a seated player of this game or the host may listen.
        const viewer = !current
          ? undefined
          : (store.authenticate(
              current,
              playerToken(request, current.gameId),
            ) ??
            ((await isAdmin(request).catch(() => false)) ? 'host' : undefined));
        if (!current || !viewer) {
          socket.close(1008, 'UNAUTHORIZED');
          return;
        }
        const gameId = current.gameId;
        const sockets = live.get(gameId) ?? new Map<WebSocket, string>();
        const own = [...sockets.values()].filter((v) => v === viewer).length;
        if (sockets.size >= MAX_LIVE_PER_GAME || own >= MAX_LIVE_PER_VIEWER) {
          socket.close(1008, 'TOO_MANY_CONNECTIONS');
          return;
        }
        sockets.set(socket, viewer);
        live.set(gameId, sockets);
        socket.on('message', () => socket.close(1008, 'READ_ONLY'));
        socket.on('close', () => {
          sockets.delete(socket);
          if (!sockets.size) live.delete(gameId);
        });
      },
    );
    done();
  });
  return store;
}
