import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = join(__dirname, 'dist', 'index.js');

// Если сборка еще не выполнялась, собираем проект
if (!fs.existsSync(distPath)) {
  console.log('Сборка TypeScript проекта (npm run build)...');
  const { execSync } = await import('node:child_process');
  execSync('npm run build', { stdio: 'inherit' });
}

// Запускаем скомпилированный бот
await import('./dist/index.js');
