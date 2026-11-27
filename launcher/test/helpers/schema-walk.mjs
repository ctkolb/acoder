// Helpers for the schema tests: every node of a JSON-like value with its path, and a value of another type.
export function nodes(root) {
  const found = [];
  const walk = (value, parts) => {
    if (value === null || typeof value !== 'object') return;
    for (const key of Array.isArray(value) ? value.map((_, index) => index) : Object.keys(value)) {
      const here = [...parts, key];
      found.push({ parts: here, dotted: here.join('.'), wild: here.map(part => (typeof part === 'number' ? '*' : part)).join('.'), key, node: value[key] });
      walk(value[key], here);
    }
  };
  walk(root, []);
  return found;
}

// A value of another type than the one in the sample (an object for null, which is valid for no field the tests walk).
export const wrongTypeOf = value => {
  if (value === null) return {};
  return typeof value === 'string' || (typeof value === 'object' && !Array.isArray(value)) ? 7 : 'x';
};

// A copy of root with the node at parts changed by change(parent, key).
export function changed(root, parts, change) {
  const copy = structuredClone(root);
  let target = copy;
  for (const part of parts.slice(0, -1)) target = target[part];
  change(target, parts.at(-1));
  return copy;
}
