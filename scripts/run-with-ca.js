import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const caPath = path.join(repoRoot, 'certs', 'russian-trusted-root-ca.pem');
const [entrypoint, ...args] = process.argv.slice(2);

if (!entrypoint) {
  console.error('Usage: node scripts/run-with-ca.js <entrypoint> [...args]');
  process.exit(1);
}

const env = { ...process.env };
if (!env.NODE_EXTRA_CA_CERTS && existsSync(caPath)) {
  env.NODE_EXTRA_CA_CERTS = caPath;
}

const child = spawn(process.execPath, [path.join(repoRoot, entrypoint), ...args], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Child process exited from signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
