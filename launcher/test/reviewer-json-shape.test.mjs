import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { LAUNCHER } from './helpers/fixtures.mjs';
import { allowedValues, minimalValue, reportTemplate, shapeErrors } from './helpers/reviewer-json-shape.mjs';

const t = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);

const template = reportTemplate(fs.readFileSync(path.join(LAUNCHER, '..', 'skills', 'acoder-reviewer', 'references', 'role.md'), 'utf8'));
const withField = change => { const report = structuredClone(minimalValue(template)); change(report); return report; };

// R48-01: the shape that spec24-skill-bytes asserts is the skill's: the template names the allowed values of status and verdict, and the
// minimal report built from it has the shape with no null anywhere.
t('reviewer-json-shape: the minimal report built from the reviewer skill\'s template has the template\'s shape and no null value', () => {
  assert.deepEqual(allowedValues(template.status), ['complete', 'incomplete', 'blocked']);
  assert.deepEqual(allowedValues(template.verdict), ['READY', 'READY_WITH_CHANGES', 'NOT_READY']);
  assert.equal(allowedValues(template.session), null, 'a placeholder string names any string');
  const report = minimalValue(template);
  assert.deepEqual(shapeErrors(report, template), []);
  assert.ok(!JSON.stringify(report).includes('null'), 'every field carries a value');
  assert.equal(report.coverage.length, 1, 'an array with an item template gets one item, so the item\'s fields are checked too');
});

// R48-01 sensitivity: one field of a wrong type, a value outside the allowed set, null, or a missing field is a difference naming that field.
t('reviewer-json-shape: a wrong type, a disallowed value, null or a missing field in one place is found and named', () => {
  const cases = [
    [report => { report.versions.tests_run = '0'; }, 'report.versions.tests_run: expected number, got string'],
    [report => { report.status = 'done'; }, 'report.status: "done" is not one of complete, incomplete, blocked'],
    [report => { report.verdict = null; }, 'report.verdict: expected string, got null'],
    [report => { report.coverage[0].result = 'OK'; }, 'report.coverage[0].result: "OK" is not one of PASS, FAIL, NOT_CHECKED'],
    [report => { report.findings[0].line = '12'; }, 'report.findings[0].line: expected number, got string'],
    [report => { report.repository_unchanged = 'true'; }, 'report.repository_unchanged: expected boolean, got string'],
    [report => { report.not_checked = 'none'; }, 'report.not_checked: expected array, got string'],
    [report => { report.validator = []; }, 'report.validator: expected object, got array'],
    [report => { delete report.riskiest_points; }, 'report.riskiest_points: missing'],
  ];
  for (const [change, expected] of cases) assert.deepEqual(shapeErrors(withField(change), template), [expected]);
});
