// The canonical state of protocol.md §5.1: a JSON value serialized with the
// JSON Canonicalization Scheme, RFC 8785.
//
// RFC 8785 serializes numbers and strings exactly as ECMAScript's
// JSON.stringify does, and sorts object members by their names as arrays of
// UTF-16 code units, which is what Array.prototype.sort does with strings.
// So in JavaScript it is a recursive JSON.stringify with sorted keys. The
// input must be I-JSON: a string that is not well-formed Unicode (a lone
// surrogate) or a number that is not finite has no canonical form.

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${value} has no canonical form`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('a string with a lone surrogate has no canonical form');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const names = Object.keys(value).sort();
    for (const name of names) if (!name.isWellFormed()) throw new Error('a member name with a lone surrogate has no canonical form');
    return '{' + names.map((name) => JSON.stringify(name) + ':' + canonicalize(value[name])).join(',') + '}';
  }
  throw new Error(`a ${typeof value} is not JSON`);
}
