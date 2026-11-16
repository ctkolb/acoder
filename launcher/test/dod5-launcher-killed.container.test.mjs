import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { docker, listLabelled, SKIP } from './helpers/container-env.mjs';
import { withContainerEnv } from './helpers/container-run.mjs';
import { lastLine, runMain } from './helpers/fixtures.mjs';
import { startLauncher } from './helpers/launcher-process.mjs';

// G11: every test has a finite time limit of its own and is registered from this file; skipped with the reason without a runtime or
// ACODER_TEST_IMAGE (S4-AC17). Each container test asserts on the record and files its own run produced.
const t = (name, fn, timeout = 300000) => nodeTest(name, { timeout, skip: SKIP }, fn);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// S4-AC13 (DoD 5; A6.9) dod5-launcher-killed: the launcher process is killed after the release: both containers are gone within 30 s, the
// stub endpoint receives no further request, the started file exists and no run record exists. Then (S4-AC14) `acoder review cleanup`
// removes the volume, the network EXT (here the launcher's own, made --internal by the test) and the staging directory, writes the crashed
// file of A6.9 and leaves the ticket unlaunchable.
t('dod5-launcher-killed: after SIGKILL of the launcher both containers end within 30 s, nothing more reaches the endpoint; review cleanup removes the rest', async () => {
  await withContainerEnv({ scenario: 'never' }, async context => {
    const { fx } = context;
    const launcher = startLauncher(context, { ownNetwork: true });
    assert.ok(await launcher.until(() => context.endpointCount() >= 2, 150000), `the agent made requests: ${JSON.stringify(launcher.timeline().slice(-3))}`);
    process.kill(launcher.child.pid, 'SIGKILL');
    const killedAt = Date.now();
    await launcher.done;
    const started = JSON.parse(fs.readFileSync(fx.writable.startedRecord, 'utf8'));
    const label = `label=acoder.run=${started.run_id}`;
    let gone = false;
    while (!gone && Date.now() - killedAt < 30000) { gone = (await listLabelled(label)).containers.length === 0; if (!gone) await wait(250); }
    assert.ok(gone, 'both containers were gone within 30 s of the kill');
    const count = context.endpointCount();
    await wait(3000);
    assert.equal(context.endpointCount(), count, 'the stub endpoint received no further request');
    assert.equal(fs.existsSync(fx.writable.runRecord), false, 'no run record was written');
    const left = await listLabelled(label);
    assert.equal(left.volumes.length, 1, 'the volume remains after the kill');
    assert.equal(left.networks.length, 1, 'the network EXT remains after the kill');
    assert.ok(fs.existsSync(started.resources.staging), 'the staging directory remains after the kill');
    // The test's stub endpoint was connected to the launcher's EXT; it leaves before the owner's cleanup.
    await docker(['network', 'disconnect', '--force', started.resources.network, `stub-${context.ids.id}`]);
    const cleanup = await runMain(['review', 'cleanup', '--mailbox', fx.mailbox, '--ticket', fx.ticket], { env: { PATH: process.env.PATH } });
    assert.equal(cleanup.code, 0, `${cleanup.stdout}${cleanup.stderr}`);
    assert.deepEqual(await listLabelled(label), { containers: [], volumes: [], networks: [] }, 'the volume and the network are removed');
    assert.equal(fs.existsSync(started.resources.staging), false, 'the staging directory is removed');
    const crashed = JSON.parse(fs.readFileSync(path.join(fx.stage, `run-${fx.tag}.crashed.json`), 'utf8'));
    assert.deepEqual(Object.keys(crashed).sort(), ['format', 'removed', 'run_id', 'started', 'tag', 'time']);
    assert.deepEqual([crashed.format, crashed.run_id, crashed.tag, crashed.started], ['acoder-run-crashed/1', started.run_id, fx.tag, true]);
    assert.deepEqual([...crashed.removed].sort(), [started.resources.network, started.resources.staging, started.resources.volume].sort());
    assert.ok(fs.existsSync(fx.writable.startedRecord), 'the started file stays');
    const again = await runMain(context.argv(), { env: { PATH: process.env.PATH, ACODER_MODEL_API_KEY: fx.key }, deps: { launchEnabled: true } });
    assert.equal(again.code, 2, 'the ticket stays unlaunchable');
    assert.equal(lastLine(again.stdout), `ACODER LAUNCH ${fx.tag} refused -`);
  });
});
