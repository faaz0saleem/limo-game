/**
 * Parse-checks every source file without needing a browser.
 * `node --check` does not understand ESM `import`, so we compile each module
 * with the VM's SourceTextModule-free path: dynamic `new Function` won't accept
 * imports either, so we lean on the parser via `import()` of a data: URL that
 * only *parses* the file (imports are rewritten to no-ops).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

const files = (await readdir(srcDir)).filter((f) => f.endsWith('.js'));
let failed = 0;

for (const file of files) {
  const code = await readFile(join(srcDir, file), 'utf8');
  try {
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(code, { identifier: file });
    console.log(`  ok   ${file}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${file}: ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed to parse.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} modules parsed cleanly.`);
