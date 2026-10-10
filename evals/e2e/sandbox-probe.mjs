import { socketPathFor } from '../../dist/core/gateway/control-socket.js';
import { SandboxExecutor } from '../../dist/core/sandbox/executor.js';

const sandbox = new SandboxExecutor({ denyWrite: [], denyRead: [] });
try {
  const socket = socketPathFor(process.env.MUFFIN_HOME);
  process.stdout.write(`${JSON.stringify({ ...(await sandbox.verify()), socket })}\n`);
} finally {
  await sandbox.close();
}
