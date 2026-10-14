/**
 * Verify every named import in a file actually exists in its target module.
 *
 * `node --check` only validates syntax — it does NOT resolve imports. So a typo
 * like `import { finalizeThreads }` passes the syntax check and then crashes at
 * runtime inside a GitHub Actions run. This catches that class of error before it
 * ships, without executing the module's top-level code (which for the pipeline
 * entrypoints means connecting to Supabase).
 *
 * Usage: node scratch/check_imports.mjs cron/auto_reply.js [more files...]
 */

import fs from 'node:fs';
import path from 'node:path';

function exportedNames(source) {
  const names = new Set();

  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }

  for (const match of source.matchAll(/export\s*\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?/g)) {
    for (const item of match[1].split(',')) {
      const parts = item.trim().split(/\s+as\s+/);
      const exported = parts[parts.length - 1]?.trim();
      if (exported) names.add(exported);
    }
  }

  return names;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scratch/check_imports.mjs <file.js> [...]');
  process.exit(1);
}

let problems = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(path.resolve(file));
  const imports = [...src.matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)];

  if (!imports.length) {
    console.log(`—   ${file} (no named imports)`);
    continue;
  }

  let fileOk = true;
  for (const m of imports) {
    // `import { original as alias }` — the EXPORT is named `original`, so that is
    // the name to look for. Taking the alias here was the checker's own first bug.
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const spec = m[2];
    if (!spec.startsWith('.')) continue; // bare specifier = node_modules, skip

    const target = path.resolve(dir, spec);
    if (!fs.existsSync(target)) {
      console.log(`✗   ${file} → ${spec} DOES NOT EXIST`);
      problems++; fileOk = false;
      continue;
    }
    try {
      // Importing a cron dependency executes its module top level. Some
      // dependencies validate production credentials there, which made a
      // read-only import check fail before the real pipeline could run. Parse
      // the ESM export declarations instead, and syntax-check the target.
      const syntax = await import('node:child_process').then(({ spawnSync }) =>
        spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
      );
      if (syntax.status !== 0) throw new Error(syntax.stderr.trim() || 'syntax check failed');

      const exports = exportedNames(fs.readFileSync(target, 'utf8'));
      const missing = names.filter((n) => !exports.has(n));
      if (missing.length) {
        console.log(`✗   ${file} → ${spec}: MISSING EXPORT ${missing.join(', ')}`);
        problems++; fileOk = false;
      }
    } catch (err) {
      console.log(`✗   ${file} → ${spec}: IMPORT THREW — ${err.message}`);
      problems++; fileOk = false;
    }
  }
  if (fileOk) console.log(`✓   ${file} — all named imports resolve`);
}

console.log(problems === 0 ? '\nAll imports resolve.' : `\n${problems} problem(s) found.`);
process.exit(problems === 0 ? 0 : 1);
