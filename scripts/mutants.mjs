#!/usr/bin/env node
// Mutation runner for suites run with `node --test` (stub: every function throws until implemented).

export function parseArguments() {
  throw new Error('not implemented');
}

export function validateMutants() {
  throw new Error('not implemented');
}

export function summarizeEvents() {
  throw new Error('not implemented');
}

export async function run() {
  throw new Error('not implemented');
}

// A reporter module for `node --test --test-reporter=<this file>`.
export default async function* reporter() {
  throw new Error('not implemented');
}

const isEntryPoint = process.argv[1] && import.meta.filename === process.argv[1];
if (isEntryPoint) {
  process.stderr.write('mutants: not implemented\n');
  process.exit(1);
}
