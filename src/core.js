import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function createCore(env = process.env, write = (line) => process.stdout.write(`${line}\n`)) {
  return {
    info(message) {
      write(String(message));
    },
    warning(message) {
      write(`::warning::${escapeData(message)}`);
    },
    error(message) {
      write(`::error::${escapeData(message)}`);
    },
    mask(value) {
      if (value) write(`::add-mask::${value}`);
    },
    setOutput(name, value) {
      const text = value === undefined || value === null ? '' : String(value);
      if (!env.GITHUB_OUTPUT) {
        write(`${name}=${text}`);
        return;
      }
      if (text.includes('\n')) {
        const delimiter = `ghadelimiter_${randomUUID()}`;
        appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
      } else {
        appendFileSync(env.GITHUB_OUTPUT, `${name}=${text}\n`);
      }
    },
    summary(markdown) {
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    },
  };
}
