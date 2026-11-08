import assert from 'node:assert';
import http from 'node:http';
import { startHealthServer, stopHealthServer } from '../src/services/healthServer.js';

function request(url: string, method: string = 'GET'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('--- ТЕСТ: Health-сервер (Render / UptimeRobot) ---');
  const testPort = 3199;
  const server = startHealthServer(testPort);

  try {
    // 1. Тест /ping
    const pingRes = await request(`http://127.0.0.1:${testPort}/ping`);
    assert.strictEqual(pingRes.status, 200, 'Статус /ping должен быть 200');
    assert.strictEqual(pingRes.body, 'pong', 'Тело /ping должно быть pong');
    console.log('✅ GET /ping -> 200 "pong"');

    // 2. Тест /health
    const healthRes = await request(`http://127.0.0.1:${testPort}/health`);
    assert.strictEqual(healthRes.status, 200, 'Статус /health должен быть 200');
    const healthJson = JSON.parse(healthRes.body);
    assert.strictEqual(healthJson.status, 'ok', 'status в /health должен быть ok');
    assert.strictEqual(typeof healthJson.uptimeSec, 'number', 'uptimeSec должен быть числом');
    console.log('✅ GET /health -> 200 JSON { status: "ok" }');

    // 3. Тест корня /
    const rootRes = await request(`http://127.0.0.1:${testPort}/`);
    assert.strictEqual(rootRes.status, 200, 'Статус / должен быть 200');
    const rootJson = JSON.parse(rootRes.body);
    assert.strictEqual(rootJson.service, 'giveaway-contest-bot');
    console.log('✅ GET / -> 200 JSON { service: "giveaway-contest-bot" }');

    // 4. Тест 404
    const notFoundRes = await request(`http://127.0.0.1:${testPort}/not-found-route`);
    assert.strictEqual(notFoundRes.status, 404, 'Несуществующий роут должен отдавать 404');
    console.log('✅ GET /unknown -> 404');

    // 5. Тест метода POST (Method Not Allowed)
    const postRes = await request(`http://127.0.0.1:${testPort}/ping`, 'POST');
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
