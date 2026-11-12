// States V and S of A6.6 up to and including the verification of the snapshot. Every check after the copy reads the COPY,
// so the bytes that were verified are the bytes that are mounted (A2, design rule 2). Returns what the plan and the record need.
import fs from 'node:fs';
import path from 'node:path';
import { parseManifest, mismatchMessage, readSmallFile, sha256File, treeHash, verifyExport } from './integrity.mjs';
import { checkLaunchPaths } from './paths.mjs';
import { Refusal, safe } from './refusal.mjs';
import { createStaging, removeStaging, resolveExcludes, takeSnapshot } from './snapshot.mjs';

const MAX_TICKET_BYTES = 1048576;
const MAX_MANIFEST_BYTES = 67108864;
const MAX_LEDGER_BYTES = 16777216;

// A2.4.2, A2.4.3 and A2.3.2 on the copy of the ticket and of the ledger.
function verifyTicketAndLedger(options, writable, copyOf) {
  if (sha256File(copyOf(options.ticket)) !== options.ticketSha256) throw new Refusal('ticket hash mismatch');
  const text = readSmallFile(copyOf(options.ticket), 'the ticket', MAX_TICKET_BYTES);
  const lines = text.split('\n');
  if (lines[0] !== `TICKET ${writable.tag}`) throw new Refusal('ticket line 1 must be exactly TICKET <tag>');
  if (!lines[1]?.startsWith('To: REVIEWER')) throw new Refusal('ticket line 2 must start with "To: REVIEWER"');
  for (const required of [writable.scratch, writable.reportMd, writable.reportJson]) {
    if (!text.includes(required)) throw new Refusal(`the ticket text does not contain the path ${safe(required)}`);
  }
  let ledger;
  try { ledger = JSON.parse(readSmallFile(copyOf(path.join(options.mailbox, 'orchestrator', 'tickets.json')), 'the ledger', MAX_LEDGER_BYTES)); } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('the ledger orchestrator/tickets.json is not valid JSON');
  }
  const entries = Array.isArray(ledger) ? ledger : ledger?.tickets;
  if (!Array.isArray(entries)) throw new Refusal('the ledger orchestrator/tickets.json holds no list of tickets');
  const matching = entries.filter(entry => entry?.tag === writable.tag);
  if (matching.length !== 1) throw new Refusal(`the ledger has ${matching.length} entries for the tag ${writable.tag}, exactly one is required`);
  if (matching[0].role !== 'REVIEWER' || matching[0].state !== 'pending') throw new Refusal('the ledger entry of this tag must have role REVIEWER and state pending');
}

function verifyExports(options, snapshot, copyOf) {
  const manifests = {};
  const exports = {};
  for (const { role, dir } of options.exports) {
    const file = options.manifests[role];
    if (sha256File(copyOf(file)) !== options.manifestSha256[role]) throw new Refusal(`manifest hash mismatch for export ${role}`);
    let manifest;
    try { manifest = parseManifest(readSmallFile(copyOf(file), `the manifest of ${role}`, MAX_MANIFEST_BYTES)); } catch (error) {
      throw error instanceof Refusal ? new Refusal(`export ${role}: ${error.message}`) : error;
    }
    const mismatches = verifyExport(snapshot.exports[role], manifest);
    if (mismatches.length > 0) throw new Refusal(mismatchMessage(role, mismatches));
    manifests[role] = { path: file, sha256: options.manifestSha256[role], source_commit: manifest.source_commit };
    exports[role] = {
      dir, copy: snapshot.exports[role], inside_mailbox: dir.startsWith(`${options.mailbox}/`),
      tree_sha256: treeHash(snapshot.exports[role]), entries: manifest.entries.length,
    };
  }
  return { manifests, exports };
}

// deps.afterSnapshot({ staging, mailbox, exports }) is a test hook that runs after the copy and before the verification.
export function prepare(options, env, deps = {}) {
  const { writable, skill, stagingParent } = checkLaunchPaths(options, env, deps);
  const ledger = path.join(options.mailbox, 'orchestrator', 'tickets.json');
  const excludes = resolveExcludes({
    mailbox: options.mailbox, excludes: options.excludes, ticket: options.ticket, ledger,
    manifests: Object.values(options.manifests), exports: options.exports.map(entry => entry.dir),
  });
  const staging = createStaging(stagingParent);
  const cleanup = () => removeStaging(staging.dir, staging.runId);
  try {
    const snapshot = takeSnapshot({ staging, mailbox: options.mailbox, exports: options.exports, excludes, writable, skill, limits: { bytes: options.snapshotMaxBytes } });
    deps.afterSnapshot?.({ staging: staging.dir, mailbox: snapshot.mailbox, exports: snapshot.exports });
    const copyOf = file => path.join(snapshot.mailbox, path.relative(options.mailbox, file));
    verifyTicketAndLedger(options, writable, copyOf);
    const { manifests, exports } = verifyExports(options, snapshot, copyOf);
    return {
      tag: writable.tag, writable: { stage: writable.stage, scratch: writable.scratch, reportMd: writable.reportMd, reportJson: writable.reportJson },
      staging: { dir: staging.dir, runId: staging.runId, mailbox: snapshot.mailbox, skill: snapshot.skill, exports: snapshot.exports },
      ticket: { path: options.ticket, sha256: options.ticketSha256 }, manifests, exports, excluded: [...options.excludes].sort(),
      snapshot: { bytes: snapshot.bytes, entries: snapshot.entries }, skillSha256: treeHash(snapshot.skill), cleanup,
    };
  } catch (error) {
    try { cleanup(); } catch { /* the original refusal is the one to report */ }
    throw error;
  }
}
