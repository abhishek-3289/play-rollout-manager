import { run } from './run.js';

const result = await run();
if (result.failed) process.exitCode = 1;
