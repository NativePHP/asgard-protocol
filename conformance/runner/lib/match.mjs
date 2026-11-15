// Matching an answer against a case's expectation. The rules are in
// conformance/README.md under "Matchers". In short:
//
//   objects        match member for member; extra members fail, unless the
//                  expected object has "$partial": true, or the member is
//                  `message` next to `error` (§7.3 lets any error carry one)
//   arrays         match item for item, unless the first expected item is
//                  "{{contains}}": then each later item must match some item
//   {"$anyOf": []} matches when any of the listed expectations does
//   "{{...}}"      a matcher string, below
//
// Matcher strings: any, absent, string, int, bool, object, array, version,
// made_at, point, nonempty, save:NAME, version:NAME, =NAME, !=NAME,
// oneOf:a|b|c. A trailing ? (int?, version?) also accepts a missing member.
// A plain string matches only itself.

const VERSION = /^[A-Za-z0-9_-]{1,64}$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function show(v) {
  const s = JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 160 ? s.slice(0, 157) + '...' : s;
}

function matcher(spec, actual, path, vars, errors) {
  const m = /^\{\{(.*)\}\}$/.exec(spec);
  let [name, ...rest] = m[1].split(':');
  if (name.endsWith('?')) {
    if (actual === undefined) return;
    name = name.slice(0, -1);
  }
  const arg = rest.join(':');
  const fail = (why) => errors.push(`${path}: ${why}, got ${show(actual)}`);
  switch (name) {
    case 'any':
      if (actual === undefined) fail('expected a value');
      return;
    case 'absent':
      if (actual !== undefined) fail('expected no member');
      return;
    case 'string':
      if (typeof actual !== 'string') fail('expected a string');
      return;
    case 'nonempty':
      if (typeof actual !== 'string' || actual === '') fail('expected a non-empty string');
      return;
    case 'int':
      if (!Number.isInteger(actual)) fail('expected an integer');
      return;
    case 'bool':
      if (typeof actual !== 'boolean') fail('expected a boolean');
      return;
    case 'object':
      if (typeOf(actual) !== 'object') fail('expected an object');
      return;
    case 'array':
      if (!Array.isArray(actual)) fail('expected an array');
      return;
    case 'made_at': {
      const now = Date.now();
      if (!Number.isInteger(actual) || actual <= 0) fail('expected made_at, an integer of milliseconds');
      else if (Math.abs(actual - now) > 86400000) fail('expected made_at within a day of now, in milliseconds');
      return;
    }
    case 'point':
      if (typeof actual !== 'string' || !/^[A-Za-z0-9_-]+$/.test(actual) || Buffer.from(actual, 'base64url').length !== 65 || Buffer.from(actual, 'base64url')[0] !== 4) {
        fail('expected an uncompressed P-256 point in base64url');
      }
      return;
    case 'version':
      if (typeof actual !== 'string' || !VERSION.test(actual)) fail('expected a version token (1 to 64 of A-Z a-z 0-9 _ -)');
      else if (arg) vars[arg] = actual;
      return;
    case 'save':
      if (actual === undefined) fail('expected a value to save');
      else vars[arg] = actual;
      return;
    case 'oneOf':
      if (!arg.split('|').includes(String(actual))) fail(`expected one of ${arg}`);
      return;
    default:
      if (name.startsWith('!=')) {
        if (JSON.stringify(actual) === JSON.stringify(vars[name.slice(2)])) fail(`expected anything but ${name.slice(2)} (${show(vars[name.slice(2)])})`);
        return;
      }
      if (name.startsWith('=')) {
        if (JSON.stringify(actual) !== JSON.stringify(vars[name.slice(1)])) fail(`expected ${name.slice(1)} (${show(vars[name.slice(1)])})`);
        return;
      }
      throw new Error(`unknown matcher ${spec} at ${path}`);
  }
}

export function match(expected, actual, path = '$', vars = {}, errors = []) {
  if (typeof expected === 'string' && /^\{\{.*\}\}$/.test(expected)) {
    matcher(expected, actual, path, vars, errors);
    return errors;
  }
  if (typeOf(expected) === 'object' && Array.isArray(expected.$anyOf)) {
    const attempts = expected.$anyOf.map((alt) => {
      const scratch = { ...vars };
      const errs = match(alt, actual, path, scratch, []);
      return { errs, scratch };
    });
    const good = attempts.find((a) => a.errs.length === 0);
    if (good) Object.assign(vars, good.scratch);
    else errors.push(`${path}: matched none of ${expected.$anyOf.length} alternatives (${attempts.map((a) => a.errs[0]).join(' | ')})`);
    return errors;
  }
  if (actual === undefined) {
    errors.push(`${path}: missing, expected ${show(expected)}`);
    return errors;
  }
  if (typeOf(expected) !== typeOf(actual)) {
    errors.push(`${path}: expected ${show(expected)}, got ${show(actual)}`);
    return errors;
  }
  if (Array.isArray(expected)) {
    if (expected[0] === '{{contains}}') {
      for (const [i, want] of expected.slice(1).entries()) {
        const hit = actual.some((item) => match(want, item, `${path}[?]`, { ...vars }, []).length === 0);
        if (!hit) errors.push(`${path}: no item matches expected item ${i} ${show(want)}`);
        else actual.find((item) => match(want, item, `${path}[?]`, vars, []).length === 0);
      }
      return errors;
    }
    if (expected.length !== actual.length) {
      errors.push(`${path}: expected ${expected.length} items, got ${actual.length}: ${show(actual)}`);
      return errors;
    }
    expected.forEach((want, i) => match(want, actual[i], `${path}[${i}]`, vars, errors));
    return errors;
  }
  if (typeOf(expected) === 'object') {
    const partial = expected.$partial === true;
    for (const [k, want] of Object.entries(expected)) {
      if (k === '$partial') continue;
      match(want, actual[k], `${path}.${k}`, vars, errors);
    }
    if (!partial) {
      for (const k of Object.keys(actual)) {
        if (k in expected) continue;
        if (k === 'message' && 'error' in actual && typeof actual.message === 'string') continue;
        errors.push(`${path}: unexpected member ${k} = ${show(actual[k])}`);
      }
    }
    return errors;
  }
  if (expected !== actual) errors.push(`${path}: expected ${show(expected)}, got ${show(actual)}`);
  return errors;
}

/** Replace "{{NAME}}" strings in a request with saved values. */
export function substitute(value, vars) {
  if (typeof value === 'string') {
    const m = /^\{\{([A-Za-z0-9_]+)\}\}$/.exec(value);
    if (m && m[1] in vars) return vars[m[1]];
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (all, n) => (n in vars ? String(vars[n]) : all));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [substitute(k, vars), substitute(v, vars)]));
  }
  return value;
}
