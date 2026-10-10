import { SandboxExecutor } from '../../dist/core/sandbox/executor.js';

const sandbox = new SandboxExecutor({ denyWrite: [], denyRead: [] });
try {
  process.stdout.write(`${JSON.stringify(await sandbox.verify())}\n`);
} finally {
  await sandbox.close();
}
