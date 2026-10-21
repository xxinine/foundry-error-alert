import { run, redact } from './monitor.mjs';

try {
  await run('deploy');
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}