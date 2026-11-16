import assert from 'node:assert';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startHealthServer, stopHealthServer } from '../src/services/healthServer.js';

function request(server: http.Server, url: string, method: string = 'GET'): Promise<{ status: number; body: string; headers: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: data,
          headers: res.headers,
        });
      });
    });
    req.on('error', (err: any) => {
      // In isolated/sandboxed environments without loopback TCP socket permission (EACCES),
      // simulate the request in-process directly against the server's HTTP handler
      if (err.code === 'EACCES') {
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname + parsedUrl.search;
        const mockReq: any = new EventEmitter();
        mockReq.url = path;
        mockReq.method = method;
        mockReq.headers = {};

        let body = '';
        const headers: Record<string, any> = {};
        const mockRes: any = new EventEmitter();
        mockRes.statusCode = 200;
        mockRes.writeHead = (status: number, hdrs?: any) => {
          mockRes.statusCode = status;
          if (hdrs) Object.assign(headers, hdrs);
          return mockRes;
        };
        mockRes.setHeader = (k: string, v: any) => {
          headers[k.toLowerCase()] = v;
        };
        mockRes.write = (chunk: any) => {
          if (chunk) body += chunk.toString();
          return true;
        };
        mockRes.end = (chunk?: any) => {
          if (chunk) body += chunk.toString();
          resolve({
            status: mockRes.statusCode,
            body,
            headers,
          });
        };

        server.emit('request', mockReq, mockRes);
        return;
      }
      reject(err);
    });
    req.end();
  });
}

async function runTests() {
  console.log('--- ТЕСТ: Health-сервер (Render / UptimeRobot) ---');
  const testPort = 3199;
  const server = await startHealthServer(testPort);

  try {
    // 1. Тест /ping
    const pingRes = await request(server, `http://127.0.0.1:${testPort}/ping`);
    assert.strictEqual(pingRes.status, 200, 'Статус /ping должен быть 200');
    assert.strictEqual(pingRes.body, 'pong', 'Тело /ping должно быть pong');
    console.log('✅ GET /ping -> 200 "pong"');

    // 2. Тест /health
    const healthRes = await request(server, `http://127.0.0.1:${testPort}/health`);
    assert.strictEqual(healthRes.status, 200, 'Статус /health должен быть 200');
    const healthJson = JSON.parse(healthRes.body);
    assert.strictEqual(healthJson.status, 'ok', 'status в /health должен быть ok');
    assert.strictEqual(typeof healthJson.uptimeSec, 'number', 'uptimeSec должен быть числом');
    console.log('✅ GET /health -> 200 JSON { status: "ok" }');

    // 3. Тест корня /
    const rootRes = await request(server, `http://127.0.0.1:${testPort}/`);
    assert.strictEqual(rootRes.status, 200, 'Статус / должен быть 200');
    const rootJson = JSON.parse(rootRes.body);
    assert.strictEqual(rootJson.service, 'giveaway-contest-bot');
    console.log('✅ GET / -> 200 JSON { service: "giveaway-contest-bot" }');

    // 4. Тест 404
    const notFoundRes = await request(server, `http://127.0.0.1:${testPort}/not-found-route`);
    assert.strictEqual(notFoundRes.status, 404, 'Несуществующий роут должен отдавать 404');
    console.log('✅ GET /unknown -> 404');

    // 5. Тест метода HEAD (RFC 7231)
    const headRes = await request(server, `http://127.0.0.1:${testPort}/health`, 'HEAD');
    assert.strictEqual(headRes.status, 200, 'HEAD должен отдавать 200');
    assert.strictEqual(headRes.body, '', 'HEAD не должен возвращать тело');
    console.log('✅ HEAD /health -> 200 (empty body)');

    // 6. Тест метода POST (Method Not Allowed)
    const postRes = await request(server, `http://127.0.0.1:${testPort}/ping`, 'POST');
    assert.strictEqual(postRes.status, 405, 'POST должен отдавать 405');
    console.log('✅ POST /ping -> 405 Method Not Allowed');

    console.log('\n✅ ВСЕ ТЕСТЫ HEALTH-СЕРВЕРА УСПЕШНО ПРОЙДЕНЫ!');
  } finally {
    await stopHealthServer(server);
  }
}

runTests().catch((err) => {
  console.error('❌ Ошибка в тестах health-сервера:', err);
  process.exit(1);
});
