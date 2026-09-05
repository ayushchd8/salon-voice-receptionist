#!/usr/bin/env node
// Runs API, agent and admin together with prefixed, colourised output so a
// single terminal shows the whole system. Ctrl-C stops all three.
import { spawn } from 'node:child_process';

const TARGETS = [
  { name: 'api  ', colour: '\x1b[36m', args: ['--filter', '@salon/api', 'dev'] },
  { name: 'agent', colour: '\x1b[35m', args: ['--filter', '@salon/agent', 'dev'] },
  { name: 'admin', colour: '\x1b[33m', args: ['--filter', '@salon/admin', 'dev'] },
];
const RESET = '\x1b[0m';
const children = [];

for (const t of TARGETS) {
  const child = spawn('pnpm', t.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const prefix = (line) => `${t.colour}${t.name}${RESET} │ ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) console.log(prefix(line));
    });
  }
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(prefix(`exited with code ${code}`));
  });
}

const shutdown = () => {
  for (const c of children) c.kill('SIGINT');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
