import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { buildServer } from '../apps/server/dist/app.js';
import { FileGameStore } from '../apps/server/dist/persistence/file-game-store.js';
import { AuthenticationService } from '../apps/server/dist/auth/authentication.js';
import { registerReconquista } from '../apps/server/dist/reconquista/routes.js';
import {
  addressKey,
  DEFAULT_RATE_LIMIT_POLICIES,
} from '../apps/server/dist/security/rate-limiter.js';

const { WebSocket } = createRequire(
  join(import.meta.dirname, '../apps/server/package.json'),
)('ws');

const cookies = (response) =>
  response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

async function start({ reconquistaLimits, ...options } = {}) {
  const origin = options.publicOrigin ?? 'http://127.0.0.1:3001';
  const directory = await mkdtemp(join(tmpdir(), 'ted-security-test-'));
  const store = await FileGameStore.open(directory);
  const code = await new AuthenticationService(store).initializeAdmin();
  const server = buildServer({
    logger: false,
    store,
    onClose: () => store.close(),
    ...options,
  });
  await registerReconquista(server, {
    dataDirectory: directory,
    classicStore: store,
    rateLimitPolicies: reconquistaLimits,
  });
  await server.ready();
  const request = (method, url, payload, headers = {}, from = '127.0.0.1') =>
    server.inject({
      method,
      url,
      remoteAddress: from,
      headers: { host: '127.0.0.1:3001', origin, ...headers },
      ...(payload === undefined ? {} : { payload }),
    });
  const login = await request('POST', '/api/admin/login', {
    recoveryCode: code,
  });
  assert.equal(login.statusCode, 200, login.body);
  const admin = cookies(login);
  return {
    server,
    store,
    request,
    admin,
    code,
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

void test('Requests addressed to a foreign name are refused (DNS rebinding)', async () => {
  const app = await start({ publicOrigin: 'https://ted.example.org' });
  try {
    for (const host of [
      '127.0.0.1:3001',
      'localhost:3001',
      '[::1]:3001',
      '192.168.0.20:3001',
      'casa.local:3001',
      'ted.example.org',
    ])
      assert.notEqual(
        (
          await app.request('GET', '/api/reconquista/board', undefined, {
            host,
          })
        ).statusCode,
        421,
        host,
      );
    for (const host of [
      'attacker.example.com:3001',
      'ted.example.org.evil.com',
    ]) {
      const refused = await app.request(
        'GET',
        '/api/reconquista/board',
        undefined,
        {
          host,
        },
      );
      assert.equal(refused.statusCode, 421, host);
      assert.equal(refused.json().code, 'HOST_NOT_ALLOWED');
    }
  } finally {
    await app.close();
  }
});

void test('A trusted proxy decides the names itself', async () => {
  const app = await start({ trustedProxy: '127.0.0.1' });
  try {
    const response = await app.request(
      'GET',
      '/api/reconquista/board',
      undefined,
      {
        host: 'juego.example.net',
      },
    );
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
  }
});

void test('Nicknames are unique per game and carry no hidden characters, in Classic and Reconquista', async () => {
  const app = await start();
  try {
    const classic = await app.request(
      'POST',
      '/api/admin/games',
      { configuredPlayerCount: 3 },
      { cookie: app.admin },
    );
    assert.equal(classic.statusCode, 201, classic.body);
    const join = (nickname, color) =>
      app.request('POST', `/api/games/${classic.json().gameId}/join`, {
        nickname,
        color,
      });
    assert.equal((await join('Ana', 'blue')).statusCode, 201);
    const repeated = await join(' ana ', 'red');
    assert.equal(repeated.statusCode, 409, repeated.body);
    assert.equal(repeated.json().code, 'NICKNAME_ALREADY_IN_USE');
    for (const disguised of ['Ana\u200b', '\u202eanA', 'B\u0007', 'An\u2028a'])
      assert.equal((await join(disguised, 'red')).statusCode, 400, disguised);
    assert.equal(
      (await join('\u00c1n\u00e4 \u{1f642}', 'red')).statusCode,
      201,
    );

    const created = await app.request(
      'POST',
      '/api/reconquista/games',
      { playerCount: 3 },
      { cookie: app.admin },
    );
    assert.equal(created.statusCode, 200, created.body);
    const enter = (nickname, color) =>
      app.request(
        'POST',
        `/api/reconquista/games/${created.json().gameId}/join`,
        {
          nickname,
          color,
        },
      );
    assert.equal((await enter('Bruno', 'white')).statusCode, 200);
    const twin = await enter('BRUNO', 'black');
    assert.equal(twin.statusCode, 409);
    assert.equal(twin.json().code, 'NICKNAME_IN_USE');
    assert.equal((await enter('Bru\u200dno', 'black')).statusCode, 400);
  } finally {
    await app.close();
  }
});

void test('how-to-play pages are served and their home pages lead back to the game', async () => {
  const app = await start({
    webRoot: join(import.meta.dirname, '../apps/web/dist'),
  });
  try {
    for (const url of [
      '/como-jugar',
      '/como-jugar/',
      '/como-jugar/index.html',
      '/como-jugar/en',
      '/como-jugar/en/',
      '/como-jugar/en/index.html',
    ]) {
      const response = await app.request('GET', url);
      assert.equal(response.statusCode, 302, url);
      assert.equal(response.headers.location, '/', url);
    }
    for (const url of [
      '/como-jugar/wiki/',
      '/como-jugar/wiki/tutorial.html',
      '/como-jugar/en/wiki/',
      '/como-jugar/estilo.css',
    ])
      assert.equal((await app.request('GET', url)).statusCode, 200, url);
    for (const url of [
      '/como-jugar//example.com',
      '/como-jugar/../package.json',
    ])
      assert.equal((await app.request('GET', url)).statusCode, 404, url);
  } finally {
    await app.close();
  }
});

void test('console language follows the system locale', async () => {
  const { consoleLanguage } =
    await import('../apps/server/dist/console-language.js');
  assert.equal(consoleLanguage({ LANG: 'es_AR.UTF-8' }), 'es');
  assert.equal(consoleLanguage({ LC_ALL: 'es' }), 'es');
  assert.equal(consoleLanguage({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(consoleLanguage({ LANG: 'C' }), 'en');
  assert.equal(consoleLanguage({ LANG: 'est_EE.UTF-8' }), 'en');
  assert.equal(consoleLanguage({ LC_ALL: 'en_GB', LANG: 'es_ES' }), 'en');
});

void test('The host can sign out, and the access code still signs in again', async () => {
  const app = await start();
  try {
    const forged = await app.request('POST', '/api/admin/logout', undefined, {
      cookie: app.admin,
      origin: 'http://evil.invalid',
    });
    assert.equal(forged.statusCode, 403);
    assert.equal(
      (
        await app.request('GET', '/api/admin/games', undefined, {
          cookie: app.admin,
        })
      ).statusCode,
      200,
    );
    const out = await app.request('POST', '/api/admin/logout', undefined, {
      cookie: app.admin,
    });
    assert.equal(out.statusCode, 204);
    assert.equal(out.cookies[0].value, '');
    for (const url of ['/api/admin/games', '/api/reconquista/games'])
      assert.equal(
        (await app.request('GET', url, undefined, { cookie: app.admin }))
          .statusCode,
        401,
        url,
      );
  } finally {
    await app.close();
  }
});

void test('Broken, oversized or foreign bodies are the client error in both servers', async () => {
  const app = await start();
  try {
    const created = await app.request(
      'POST',
      '/api/reconquista/games',
      { playerCount: 2 },
      { cookie: app.admin },
    );
    for (const url of [
      '/api/admin/login',
      `/api/reconquista/games/${created.json().gameId}/join`,
    ]) {
      const broken = await app.request('POST', url, '{"nickname":', {
        'content-type': 'application/json',
      });
      assert.equal(broken.statusCode, 400, url);
      const huge = await app.request(
        'POST',
        url,
        JSON.stringify({ nickname: 'a'.repeat(2_000_000) }),
        { 'content-type': 'application/json' },
      );
      assert.equal(huge.statusCode, 413, url);
      const form = await app.request('POST', url, 'nickname=a', {
        'content-type': 'application/x-www-form-urlencoded',
      });
      assert.equal(form.statusCode, 415, url);
    }
  } finally {
    await app.close();
  }
});

void test('Retake live connections close when their seat or their game goes away', async () => {
  const app = await start();
  try {
    const created = await app.request(
      'POST',
      '/api/reconquista/games',
      { playerCount: 3 },
      { cookie: app.admin },
    );
    const gameId = created.json().gameId;
    const seats = [];
    for (const [nickname, color] of [
      ['Ana', 'white'],
      ['Beto', 'black'],
    ]) {
      const joined = await app.request(
        'POST',
        `/api/reconquista/games/${gameId}/join`,
        { nickname, color },
      );
      seats.push({ id: joined.json().playerId, cookie: cookies(joined) });
    }
    const address = await app.server.listen({ host: '127.0.0.1', port: 0 });
    const listen = async (cookie) => {
      const socket = new WebSocket(
        `${address.replace('http', 'ws')}/api/reconquista/games/${gameId}/live`,
        { headers: { origin: address, cookie } },
      );
      socket.closed = new Promise((done) =>
        socket.on('close', (code, reason) => done(`${code} ${reason}`)),
      );
      await new Promise((done, fail) => {
        socket.on('open', done);
        socket.on('error', fail);
      });
      return socket;
    };
    const [ana, beto] = [
      await listen(seats[0].cookie),
      await listen(seats[1].cookie),
    ];
    const removed = await app.request(
      'DELETE',
      `/api/reconquista/games/${gameId}/players/${seats[1].id}`,
      undefined,
      { cookie: app.admin },
    );
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await beto.closed, '1008 SESSION_REVOKED');
    assert.equal(ana.readyState, WebSocket.OPEN);
    const deleted = await app.request(
      'DELETE',
      `/api/reconquista/games/${gameId}`,
      undefined,
      { cookie: app.admin },
    );
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(await ana.closed, '1008 GAME_DELETED');
  } finally {
    await app.close();
  }
});

void test('Made-up cookies and floods from other addresses never block the people playing', async () => {
  const app = await start({
    reconquistaLimits: {
      ...DEFAULT_RATE_LIMIT_POLICIES,
      'game-read': { windowMs: 60_000, source: 3, target: 5, global: 100 },
    },
  });
  try {
    const created = await app.request(
      'POST',
      '/api/reconquista/games',
      { playerCount: 3 },
      { cookie: app.admin },
    );
    const gameId = created.json().gameId;
    const joined = await app.request(
      'POST',
      `/api/reconquista/games/${gameId}/join`,
      { nickname: 'Ana', color: 'white' },
    );
    const seat = cookies(joined);
    const name = seat.split('=')[0];
    const read = (cookie, from) =>
      app.request(
        'GET',
        `/api/reconquista/games/${gameId}/entry`,
        undefined,
        cookie ? { cookie } : {},
        from,
      );
    // A new made-up cookie per request no longer earns a new allowance.
    const forged = [];
    for (let i = 0; i < 4; i++)
      forged.push((await read(`${name}=forged${i}`, '10.0.0.1')).statusCode);
    assert.deepEqual(forged, [200, 200, 200, 429]);
    // Other addresses use up the game's share for visitors without a seat...
    assert.equal((await read(undefined, '10.0.0.2')).statusCode, 200);
    assert.equal((await read(undefined, '10.0.0.2')).statusCode, 200);
    assert.equal((await read(undefined, '10.0.0.3')).statusCode, 429);
    // ...but the seated player and the host keep their own.
    assert.equal((await read(seat, '10.0.0.1')).statusCode, 200);
    const watched = await app.request(
      'GET',
      `/api/reconquista/games/${gameId}/state?observer=1`,
      undefined,
      { cookie: app.admin },
      '10.0.0.1',
    );
    assert.equal(watched.statusCode, 200, watched.body);
  } finally {
    await app.close();
  }
});

void test('Made-up host cookies count against their address before the login is read', async () => {
  const app = await start();
  try {
    let reads = 0;
    const load = app.store.loadAdminAuth.bind(app.store);
    app.store.loadAdminAuth = () => {
      reads++;
      return load();
    };
    const forged = `${app.admin.split('=')[0]}=forged`;
    const flood = async (url) => {
      reads = 0;
      const statuses = await Promise.all(
        Array.from({ length: 40 }, () =>
          app.request('GET', url, undefined, { cookie: forged }, '10.0.0.9'),
        ),
      );
      return {
        refused: statuses.filter((r) => r.statusCode === 429).length,
        reads,
      };
    };
    for (const url of ['/api/reconquista/games', '/api/admin/games']) {
      // Only the first 30 in each second reach the saved login.
      assert.deepEqual(await flood(url), { refused: 10, reads: 30 }, url);
      // The real host is not affected, and its own checks never add up.
      for (let i = 0; i < 40; i++) {
        const host = await app.request(
          'GET',
          url,
          undefined,
          { cookie: app.admin },
          '10.0.0.10',
        );
        assert.equal(host.statusCode, 200, `${url} ${host.body}`);
      }
    }
  } finally {
    await app.close();
  }
});

void test('Failed host logins slow down only the address that sent them', async () => {
  let now = 0;
  const app = await start({ rateLimitNow: () => now });
  try {
    const login = (recoveryCode, from) =>
      app.request('POST', '/api/admin/login', { recoveryCode }, {}, from);
    const wrong = 'A'.repeat(app.code.length);
    for (const from of ['10.0.0.1', '10.0.0.2', '10.0.0.3'])
      for (let i = 0; i < 10; i++) await login(wrong, from);
    assert.equal((await login(app.code, '10.0.0.4')).statusCode, 200);
    // The address that kept failing waits, even with the right code.
    const waiting = await login(app.code, '10.0.0.1');
    assert.equal(waiting.statusCode, 429);
    assert.ok(Number(waiting.headers['retry-after']) >= 1);
    now += 60_000;
    assert.equal((await login(app.code, '10.0.0.1')).statusCode, 200);
    // A fresh address gets a few free tries, then one second, then two.
    const statuses = [];
    for (let i = 0; i < 7; i++)
      statuses.push((await login(wrong, '10.0.0.5')).statusCode);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 429]);
    now += 1000;
    assert.equal((await login(wrong, '10.0.0.5')).statusCode, 401);
    now += 1000;
    assert.equal((await login(wrong, '10.0.0.5')).statusCode, 429);
    now += 1000;
    assert.equal((await login(wrong, '10.0.0.5')).statusCode, 401);
  } finally {
    await app.close();
  }
});

void test('One IPv6 network counts as one address', () => {
  assert.equal(addressKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(
    addressKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'),
    '2001:db8:1:2::/64',
  );
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(addressKey('::ffff:192.168.0.20'), '192.168.0.20');
  assert.equal(addressKey('192.168.0.20'), '192.168.0.20');
});

void test('Live connections may only go back to the server that served the page', async () => {
  const app = await start({
    publicOrigin: 'https://ted.example.org',
    trustedProxy: '127.0.0.1',
  });
  try {
    const policy = async (host) =>
      (await app.request('GET', '/api/bootstrap', undefined, { host })).headers[
        'content-security-policy'
      ];
    const own = await policy('ted.example.org');
    assert.match(
      own,
      /connect-src 'self' ws:\/\/ted\.example\.org wss:\/\/ted\.example\.org;/,
    );
    assert.doesNotMatch(own, /wss?:(?!\/\/)/);
    // Behind a proxy any name gets through; nothing odd reaches the policy.
    const odd = await policy("x; script-src 'unsafe-inline' *");
    assert.match(
      odd,
      /connect-src 'self' ws:\/\/ted\.example\.org wss:\/\/ted\.example\.org;/,
    );
    assert.doesNotMatch(odd, /unsafe-inline/);
    assert.match(
      await policy('[::1]:3001'),
      /ws:\/\/\[::1\]:3001 wss:\/\/\[::1\]:3001/,
    );
  } finally {
    await app.close();
  }
});

void test('A trusted proxy without the public origin stops the server with a clear message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ted-security-proxy-'));
  try {
    const { status, stderr } = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, '../apps/server/dist/main.js'),
        '--no-open',
        '--port',
        '39117',
        '--data-dir',
        directory,
      ],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          LANG: 'C',
          LC_ALL: 'C',
          GAME_TRUSTED_PROXY: '127.0.0.1',
          GAME_PUBLIC_ORIGIN: '',
        },
      },
    );
    assert.equal(status, 1, stderr);
    assert.match(stderr, /GAME_TRUSTED_PROXY also needs GAME_PUBLIC_ORIGIN/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('Only the host sees the installed version', async () => {
  const app = await start();
  try {
    const listed = await app.request('GET', '/api/admin/games', undefined, {
      cookie: app.admin,
    });
    assert.equal(typeof listed.json().version, 'string');
    const bootstrap = await app.request('GET', '/api/bootstrap');
    assert.equal(JSON.stringify(bootstrap.json()).includes('version"'), false);
    assert.equal(
      (await app.request('GET', '/api/admin/games')).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
