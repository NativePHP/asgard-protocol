// Checks a fragment as a client would before storing it (§9.1, §9.3, §9.4,
// §9.6, §10.1, §12.4). Returns a list of problems; empty means fine.

import constants from '../../../schema/constants.json' with { type: 'json' };

export const CORE_TYPES = constants.elements.core;
export const RESERVED_TYPES = [...constants.elements.reserved.chrome, ...constants.elements.reserved.region];
const SLOTS = constants.slots.names;
const PRESS = constants.slots.press;
const TRANSITIONS = constants.slots.transitions;
const MEDIA = constants.elements.media_props;
const MAX_DEPTH = constants.limits.fragment_depth.max;
const MAX_ARGS = constants.limits.args.max_items;
const MAX_NESTING = constants.limits.args.max_nesting;
const CALL = new RegExp(constants.limits.call.pattern);
const RESERVED_PROP = new RegExp('^(' + constants.elements.reserved_prop_prefixes.map((p) => p.replace(/[-:]/g, '\\$&')).join('|') + ')');

function depthOf(v, d = 0) {
  if (Array.isArray(v)) return Math.max(d + 1, ...v.map((x) => depthOf(x, d + 1)));
  if (v && typeof v === 'object') return Math.max(d + 1, ...Object.values(v).map((x) => depthOf(x, d + 1)));
  return d;
}

export function checkSlot(slot, name) {
  const problems = [];
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return [`${name} is not an object`];
  if ('call' in slot) {
    for (const k of Object.keys(slot)) if (!['call', 'args', 'target'].includes(k)) problems.push(`${name} has unknown member ${k}`);
    if (typeof slot.call !== 'string' || !CALL.test(slot.call)) problems.push(`${name}.call is not a method name`);
    if (!('args' in slot)) problems.push(`${name} has no args (a server MUST always send args)`);
    else if (!Array.isArray(slot.args) || slot.args.length > MAX_ARGS) problems.push(`${name}.args is not a list of at most 16`);
    else if (slot.args.some((a) => depthOf(a) > MAX_NESTING)) problems.push(`${name}.args nests deeper than 4`);
    if ('target' in slot && !['server', 'client'].includes(slot.target)) problems.push(`${name}.target is ${slot.target}`);
  } else if ('navigate' in slot) {
    if (!PRESS.includes(name)) problems.push(`${name} cannot navigate`);
    for (const k of Object.keys(slot)) if (!['navigate', 'replace', 'transition'].includes(k)) problems.push(`${name} has unknown member ${k}`);
    if (typeof slot.navigate !== 'string' || !/^\/(?!\/)[^\\\s\u0000-\u001f\u007f]*$/.test(slot.navigate) || Buffer.byteLength(slot.navigate) > 2048) problems.push(`${name}.navigate is not an app path`);
    if ('replace' in slot && typeof slot.replace !== 'boolean') problems.push(`${name}.replace is not a boolean`);
    if ('transition' in slot && !TRANSITIONS.includes(slot.transition)) problems.push(`${name}.transition is ${slot.transition}`);
  } else if ('back' in slot) {
    if (!PRESS.includes(name)) problems.push(`${name} cannot go back`);
    if (slot.back !== true) problems.push(`${name}.back is not true`);
    for (const k of Object.keys(slot)) if (!['back', 'transition'].includes(k)) problems.push(`${name} has unknown member ${k}`);
  } else {
    problems.push(`${name} is neither a call nor a navigation`);
  }
  return problems;
}

export function checkFragment(fragment, elements = []) {
  const allowed = new Set([...CORE_TYPES, ...elements.filter((t) => !RESERVED_TYPES.includes(t))]);
  const problems = [];
  const walk = (node, depth, path) => {
    if (depth > MAX_DEPTH) {
      problems.push(`${path}: nested deeper than 64 levels`);
      return;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      problems.push(`${path}: a node must be an object`);
      return;
    }
    if (typeof node.type !== 'string' || !/^[a-z][a-z0-9_]*$/.test(node.type)) problems.push(`${path}: bad type ${JSON.stringify(node.type)}`);
    else if (RESERVED_TYPES.includes(node.type)) problems.push(`${path}: reserved type ${node.type}`);
    else if (!allowed.has(node.type)) problems.push(`${path}: type ${node.type} is not core and was not advertised`);
    if ('key' in node && typeof node.key !== 'string' && !Number.isInteger(node.key)) problems.push(`${path}: key is not a string or integer`);
    if ('props' in node) {
      if (!node.props || typeof node.props !== 'object' || Array.isArray(node.props)) problems.push(`${path}: props is not an object`);
      else {
        for (const k of Object.keys(node.props)) if (RESERVED_PROP.test(k)) problems.push(`${path}: reserved prop ${k}`);
        for (const k of MEDIA) {
          const v = node.props[k];
          if (v === undefined || v === null || v === '') continue;
          if (typeof v !== 'string' || !/^https:\/\/[^/?#\s][^\s]*$/.test(v) || Buffer.byteLength(v) > 2048) problems.push(`${path}: ${k} is not an https media URL`);
        }
      }
    }
    for (const s of SLOTS) if (s in node) problems.push(...checkSlot(node[s], s).map((p) => `${path}: ${p}`));
    if ('children' in node) {
      if (!Array.isArray(node.children)) problems.push(`${path}: children is not an array`);
      else {
        const keys = new Set();
        node.children.forEach((child, i) => {
          if (child && 'key' in child) {
            const k = String(child.key);
            if (keys.has(k)) problems.push(`${path}.children: siblings share key ${k}`);
            keys.add(k);
          }
          walk(child, depth + 1, `${path}.children[${i}]`);
        });
        if (node.type === 'text') node.children.forEach((c, i) => { if (c?.type !== 'text') problems.push(`${path}.children[${i}]: a text node's children must be text`); });
      }
    }
  };
  if (Array.isArray(fragment)) {
    const keys = new Set();
    fragment.forEach((n, i) => {
      if (n && 'key' in n) {
        if (keys.has(String(n.key))) problems.push(`$[${i}]: root siblings share key ${n.key}`);
        keys.add(String(n.key));
      }
      walk(n, 1, `$[${i}]`);
    });
  } else {
    walk(fragment, 1, '$');
  }
  return problems;
}
