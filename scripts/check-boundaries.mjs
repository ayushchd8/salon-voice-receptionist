#!/usr/bin/env node
// Architectural fitness function.
//
// The central claim of this system's design is that the voice agent and the
// staff UI reach the CRM only through its published HTTP API. That claim is
// worth exactly as much as its enforcement, so it is enforced here and wired
// into `pnpm check` rather than left to code review.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const RULES = [
  {
    package: 'apps/agent',
    banned: [
      { pattern: /from\s+['"]pg['"]/, why: 'direct Postgres driver import' },
      { pattern: /from\s+['"]drizzle-orm/, why: 'direct ORM import' },
      { pattern: /from\s+['"].*apps\/api\/src/, why: 'reaching into CRM internals' },
      { pattern: /@salon\/api/, why: 'importing the CRM package' },
      { pattern: /\bDATABASE_URL\b/, why: 'reading database credentials' },
    ],
  },
  {
    package: 'apps/admin',
    banned: [
      { pattern: /from\s+['"]pg['"]/, why: 'direct Postgres driver import' },
      { pattern: /from\s+['"]drizzle-orm/, why: 'direct ORM import' },
      { pattern: /from\s+['"].*apps\/api\/src/, why: 'reaching into CRM internals' },
      { pattern: /@salon\/api/, why: 'importing the CRM package' },
      { pattern: /\bDATABASE_URL\b/, why: 'reading database credentials' },
    ],
  },
  {
    // packages/core is the pure domain layer: it must stay I/O-free so the
    // availability engine and policy rules remain unit-testable as functions.
    package: 'packages/core',
    banned: [
      { pattern: /from\s+['"]pg['"]/, why: 'core must not touch the database' },
      { pattern: /from\s+['"]drizzle-orm/, why: 'core must not touch the database' },
      { pattern: /from\s+['"]node:fs['"]/, why: 'core must be I/O-free' },
      { pattern: /\bfetch\s*\(/, why: 'core must be I/O-free' },
    ],
  },
];

const SOURCE_EXT = /\.(ts|tsx|mts|js|mjs)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite']);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(entry)) yield full;
  }
}

const violations = [];
for (const rule of RULES) {
  for (const file of walk(join(ROOT, rule.package))) {
    // The dependency-boundary check itself and package manifests are exempt.
    if (/\.test\.ts$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
      for (const { pattern, why } of rule.banned) {
        if (pattern.test(line)) {
          violations.push(`${relative(ROOT, file)}:${i + 1}  ${why}\n    ${line.trim()}`);
        }
      }
    });
  }
}

// Also assert the manifests do not declare the banned dependencies at all.
for (const rule of RULES) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(ROOT, rule.package, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const banned of ['pg', 'drizzle-orm', '@salon/api']) {
    if (deps[banned]) {
      violations.push(`${rule.package}/package.json  declares forbidden dependency "${banned}"`);
    }
  }
}

if (violations.length > 0) {
  console.error('\n✗ Architectural boundary violations:\n');
  for (const v of violations) console.error('  ' + v + '\n');
  console.error(
    'The voice agent and staff UI must reach the CRM only over its HTTP API,\n' +
      'and packages/core must stay I/O-free. See ARCHITECTURE.md §1.\n',
  );
  process.exit(1);
}

console.log('✓ boundaries intact — agent and admin hold no database access; core is I/O-free');
