import http, { Server } from 'http';

const START_TIME = Date.now();

/**
 * Формирует статус для /health
 */
function buildHealthPayload() {
  return {
    status: 'ok',
    service: 'giveaway-contest-bot',
    uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Запускает легковесный HTTP-сервер для Render и пингеров (UptimeRobot, cron-job)
 */
export function startHealthServer(port: number = 3000): Server {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    // Разрешаем только безопасные методы GET и HEAD для health-check
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method Not Allowed');
    }

    // /ping — ультралегкий текстовый ответ для UptimeRobot
    if (urlPath === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('pong');
    }

    // /health — подробный JSON статус
    if (urlPath === '/health') {
      const payload = buildHealthPayload();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(payload, null, 2));
    }

    // Главная страница /
    if (urlPath === '/') {
      const payload = {
        service: 'giveaway-contest-bot',
        status: 'running',
        endpoints: ['/ping', '/health'],
        uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(payload, null, 2));
    }

    // Все остальные пути — 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.on('error', (err: any) => {
    console.error(`⚠️ [HealthServer] Ошибка сервера: ${err?.message || err}`);
  });

  server.listen(port, () => {
    console.log(`🌐 Health-сервер слушает порт ${port} (доступны GET /ping, /health, /)`);
  });

  return server;
}

/**
 * Корректное закрытие сервера при остановке приложения
 */
export function stopHealthServer(server: Server | null | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close((err) => {
      if (err) {
        console.warn(`⚠️ [HealthServer] Предупреждение при закрытии: ${err.message}`);
      } else {
        console.log('🌐 Health-сервер успешно остановлен.');
      }
      resolve();
    });
    // Таймаут на случай незакрытых соединений
    setTimeout(() => resolve(), 3000).unref();
  });
}
