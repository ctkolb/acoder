// The shape of the reviewer's JSON report, read from the skill's own text (the report block of references/role.md), never from the
// launcher. The block is a template: a string whose words are joined by `|` (no spaces) names the allowed values; any other string means a
// string; a number means a number; a boolean means a boolean; an object means an object with the same keys, each of its template's shape; an
// array means an array whose items have the shape of the template's first item (an empty template array leaves its items open).
import assert from 'node:assert/strict';

// The template of the JSON report: the parsed report block of the protocol.
export function reportTemplate(roleText) {
  const block = /report-<tag>\.json: ONE valid JSON object[\s\S]*?```json\n([\s\S]*?)\n```/.exec(roleText);
  assert.ok(block !== null, 'the protocol holds the JSON report block');
  return JSON.parse(block[1]);
}

// The allowed values a template string names, or null when it names any string.
export const allowedValues = template => (/^[A-Za-z0-9_]+(\|[A-Za-z0-9_]+)+$/.test(template) ? template.split('|') : null);

const kind = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

// The differences between a value and its template, one line each (`at` names the field); an empty list means the value has the shape.
// null is a difference: every field of the scripted report carries a value of its type.
export function shapeErrors(value, template, at = 'report') {
  if (kind(value) !== kind(template)) return [`${at}: expected ${kind(template)}, got ${kind(value)}`];
  if (typeof template === 'string') {
    const allowed = allowedValues(template);
    return allowed !== null && !allowed.includes(value) ? [`${at}: ${JSON.stringify(value)} is not one of ${allowed.join(', ')}`] : [];
  }
  if (typeof template === 'number') return Number.isFinite(value) ? [] : [`${at}: expected a finite number`];
  if (Array.isArray(template)) return template.length === 0 ? [] : value.flatMap((item, i) => shapeErrors(item, template[0], `${at}[${i}]`));
  if (kind(template) === 'object') {
    return Object.keys(template).flatMap(key => (key in value ? shapeErrors(value[key], template[key], `${at}.${key}`) : [`${at}.${key}: missing`]));
  }
  return [];
}

// A minimal value of the template's shape: the first allowed value, a placeholder string, 0, the template's boolean, one item for an
// array with an item template (so the item's fields carry values too) and [] for an open one.
export function minimalValue(template) {
  if (typeof template === 'string') return allowedValues(template)?.[0] ?? 'scripted';
  if (typeof template === 'number') return 0;
  if (typeof template === 'boolean') return template;
  if (Array.isArray(template)) return template.length === 0 ? [] : [minimalValue(template[0])];
  return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, minimalValue(item)]));
}
