#!/usr/bin/env node
// Asgard conformance runner. Node 24, no dependencies.
//
//   node conformance/runner/run.mjs --vectors
//   node conformance/runner/run.mjs --server https://example.test/_asgard --key <asgard_key> [--case name] [-v]
//
// See conformance/README.md.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases, Runner } from './lib/cases.mjs';
import { setInsecure } from './lib/http.mjs';
import { checkConstants, checkVectors } from './lib/vectors.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function parseArgs(argv) {
  const args = { cases: [], verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--server') args.server = next();
    else if (a === '--key') args.key = next();
    else if (a === '--case') args.cases.push(...next().split(','));
    else if (a === '--transport') args.transport = next();
    else if (a === '--vectors') args.vectors = true;
    else if (a === '--vectors-file') args.vectorsFile = next();
    else if (a === '--cases-dir') args.casesDir = next();
    else if (a === '--insecure') args.insecure = true;
    else if (a === '--list') args.list = true;
    else if (a === '--json') args.json = true;
    else if (a === '-v' || a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const HELP = `Asgard conformance runner

  --vectors              check conformance/vectors/vectors.json offline
  --server URL           the server's {base}, e.g. https://app.test/_asgard
  --key KEY              the server's asgard_key (or ASGARD_KEY in the environment)
  --case NAME            run only these cases (repeat or comma-separate; a
                         trailing * matches a prefix)
  --transport MODE       auto (probe QUERY, as a client does), query or post
  --insecure             accept a TLS certificate the system does not trust
  --list                 list the cases and exit
  --json                 print results as JSON
  -v, --verbose          print each request and answer in plaintext
`;

function selected(all, names) {
  if (!names.length) return all;
  return all.filter((c) => names.some((n) => (n.endsWith('*') ? c.name.startsWith(n.slice(0, -1)) : c.name === n)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  let failed = 0;

  if (args.vectors) {
    const file = args.vectorsFile ?? path.join(root, 'vectors', 'vectors.json');
    const results = checkVectors(file);
    console.log(`Vectors: ${path.relative(process.cwd(), file)}`);
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`);
      for (const n of r.notes ?? []) console.log(`        note: ${n}`);
    }
    const disagree = checkConstants(path.resolve(root, '..', 'schema'));
    results.push({ name: 'constants agree with fragment.schema.json', ok: disagree.length === 0, detail: disagree.join('; ') });
    const last = results[results.length - 1];
    console.log(`  ${last.ok ? 'PASS' : 'FAIL'}  ${last.name}${last.ok ? '' : `\n        ${last.detail}`}`);
    const bad = results.filter((r) => !r.ok).length;
    console.log(`  ${results.length - bad} passed, ${bad} failed\n`);
    failed += bad;
  }

  const cases = loadCases(args.casesDir ?? path.join(root, 'cases'));
  if (args.list) {
    for (const c of cases) console.log(`${c.name.padEnd(40)} ${(c.sections ?? []).join(' ')}  ${c.description}`);
    return 0;
  }

  if (args.server) {
    const key = args.key ?? process.env.ASGARD_KEY;
    if (!key) throw new Error('--key (or ASGARD_KEY) is required with --server');
    if (args.insecure) setInsecure(true);
    if (!args.server.startsWith('https:')) console.log('Note: {base} is not https. Only a development server may be reached that way (§8).');

    const runner = new Runner({ base: args.server, key, transport: args.transport ?? 'auto' });
    const transport = await runner.probe();
    console.log(`Server: ${args.server}`);
    console.log(`Transport: ${transport === 'query' ? 'QUERY' : 'POST with X-Asgard-Method: QUERY'}${args.transport ? ' (forced)' : ' (probed)'}\n`);

    const todo = selected(cases, args.cases);
    const results = [];
    for (const c of todo) {
      const r = await runner.runCase(c);
      results.push(r);
      if (!args.json) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${(c.sections ?? []).join(' ')}`);
        if (!r.ok) for (const f of r.failures) console.log(`        ${f}`);
        if (args.verbose) for (const t of r.transcript) console.log(indent(JSON.stringify(t, null, 2)));
      }
    }
    const bad = results.filter((r) => !r.ok).length;
    if (args.json) console.log(JSON.stringify(results.map(({ name, ok, failures }) => ({ name, ok, failures })), null, 2));
    console.log(`\n${results.length - bad} passed, ${bad} failed, ${results.length} cases`);
    failed += bad;
  } else if (!args.vectors) {
    process.stdout.write(HELP);
    return 2;
  }

  return failed ? 1 : 0;
}

function indent(s) {
  return s.split('\n').map((l) => '        ' + l).join('\n');
}

main().then((code) => process.exit(code), (e) => {
  console.error(`error: ${e.message}`);
  process.exit(2);
});
