// Test-only wrappers of the supervisor (A11; S4-AC13): programs copied into the fixture's reviewer skill folder and started instead of
// /acoder/container/entry.mjs by a plan transform; the inspect answer is masked for that changed command only, so that H2 passes. They
// call the real supervisor's main() with altered standard input or output. No production switch exists for any of this.
import { isAgent, replaceIn } from './container-run.mjs';

// LATE_DEADLINE: the RELEASE line reaches the supervisor with its deadline 120 s later, so the supervisor's own deadline kill (the
// backstop) cannot end the agent before the launcher's stop sequence signals it; the order of a launcher stop is then observable.
export const LATE_DEADLINE = `import { PassThrough } from 'node:stream';
const input = new PassThrough();
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  for (let at = pending.indexOf('\\n'); at >= 0; at = pending.indexOf('\\n')) {
    let line = pending.slice(0, at);
    pending = pending.slice(at + 1);
    const match = /^RELEASE (\\S+) ([0-9]+)$/.exec(line);
    if (match !== null) line = 'RELEASE ' + match[1] + ' ' + String(Number(match[2]) + 120000);
    input.write(line + '\\n');
  }
});
process.stdin.on('end', () => input.end());
const entry = await import('/acoder/container/entry.mjs');
entry.main({ input });
`;

// CLOCK_REPLY: the supervisor's clock reply is altered as /acoder/skill/clock-mode.json says: {"mode": "skew", "ms": <n>} adds n ms to the
// sample, "missing" drops the reply, "malformed" replaces the sample with a fraction, "duplicate" prints the reply twice.
export const CLOCK_REPLY = `import fs from 'node:fs';
const { mode, ms } = JSON.parse(fs.readFileSync('/acoder/skill/clock-mode.json', 'utf8'));
const output = {
  write(text, callback) {
    const at = text.indexOf(' ');
    let body = null;
    try { body = at > 0 ? JSON.parse(text.slice(at + 1)) : null; } catch { body = null; }
    if (body?.event === 'clock') {
      const prefix = text.slice(0, at);
      if (mode === 'missing') { if (callback) callback(); return true; }
      if (mode === 'skew') body.clock_epoch_ms += ms;
      if (mode === 'malformed') body.clock_epoch_ms += 0.5;
      const line = prefix + ' ' + JSON.stringify(body) + '\\n';
      if (mode === 'duplicate') process.stdout.write(line);
      return process.stdout.write(line, callback);
    }
    return process.stdout.write(text, callback);
  },
};
const entry = await import('/acoder/container/entry.mjs');
entry.main({ output });
`;

// The plan transform and the inspect mask of a wrapper named `file` in the skill folder.
export const useWrapper = file => (plan) => { plan.agent.create = replaceIn(plan.agent.create, '/acoder/container/entry.mjs', `/acoder/skill/${file}`); return plan; };
export const maskWrapper = (kind, name, info) => {
  if (kind === 'container' && isAgent(name)) { info.Config.Cmd = ['/acoder/container/entry.mjs']; info.Args = ['/acoder/container/entry.mjs']; }
  return info;
};
export const lateDeadline = { skillFiles: [{ name: 'late-deadline.mjs', text: LATE_DEADLINE }], planTransform: useWrapper('late-deadline.mjs'), alter: maskWrapper };
