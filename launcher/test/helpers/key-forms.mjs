// The tests' own oracle for the key forms of A8.6 (it does not use the launcher's implementation), and the synthetic key
// generator: keys are made from random bytes at test time (G4) and are retried until the forms differ from each other.
import { randomBytes } from 'node:crypto';

const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// The characters of the base64 text of (offset bytes + key + anything) that depend on the key bytes only.
function base64Form(key, offset, alphabet) {
  const bits = [...Buffer.from(key)].map(byte => byte.toString(2).padStart(8, '0')).join('');
  const first = Math.ceil((8 * offset) / 6);
  const last = Math.floor((8 * offset + bits.length) / 6);
  let text = '';
  for (let index = first; index < last; index += 1) {
    const from = 6 * index - 8 * offset;
    text += alphabet[Number.parseInt(bits.slice(from, from + 6), 2)];
  }
  return text;
}

export function expectedForms(key) {
  const bytes = [...Buffer.from(key)];
  const forms = { raw: key };
  for (const offset of [0, 1, 2]) {
    forms[`base64-${offset}`] = base64Form(key, offset, STANDARD);
    forms[`base64url-${offset}`] = base64Form(key, offset, URL_SAFE);
  }
  forms['hex-lower'] = Buffer.from(key).toString('hex');
  forms['hex-upper'] = Buffer.from(key).toString('hex').toUpperCase();
  forms['percent-upper'] = bytes.map(byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  forms['percent-lower'] = bytes.map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
  return forms;
}

// A text that holds the key base64-encoded at the given byte alignment, with random bytes around it.
export function embedBase64(key, offset, urlSafe) {
  const message = Buffer.concat([randomBytes(offset), Buffer.from(key), randomBytes(5)]);
  return message.toString(urlSafe ? 'base64url' : 'base64').replace(/=+$/, '');
}

export function syntheticKey(length = 30) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const key = randomBytes(length).toString('base64url');
    // For a key made of [A-Za-z0-9_-] the standard and the URL-safe base64 forms are the same text: an ASCII byte has a zero top bit, so no
    // 6-bit group of its encoding is 62 or 63. Every other form must differ from all the others.
    const forms = expectedForms(key);
    for (const offset of [0, 1, 2]) if (forms[`base64-${offset}`] !== forms[`base64url-${offset}`]) throw new Error('the oracle disagrees with the alphabet argument');
    const values = Object.entries(forms).filter(([name]) => !name.startsWith('base64url-')).map(([, value]) => value);
    if (new Set(values).size === values.length) return key;
  }
  throw new Error('no synthetic key with distinct forms');
}
