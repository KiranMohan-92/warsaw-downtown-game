// `pnpm test:assets`: the Python tests of the asset pipeline (tools/assets/test_*.py) and the public-snapshot
// publisher (tools/publish/test_*.py), part of `pnpm check`.
// Runs pytest (it also collects the unittest classes). Needs Python 3 + Pillow + numpy + pytest. Locally a missing interpreter/Pillow is a loud skip (not every friend's
// machine has Python); on CI (`CI` set) it is a failure, so the gate can't silently shrink.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = new URL('.', import.meta.url);
const cwd = decodeURIComponent(dir.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const candidates =
  process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
const python = candidates.find(
  (p) => spawnSync(p, ['-c', 'import PIL, numpy, pytest'], { stdio: 'ignore' }).status === 0,
);
if (!python) {
  const msg = 'test:assets: no Python 3 with Pillow + numpy + pytest found';
  if (process.env.CI) {
    console.error(`${msg} (required on CI)`);
    process.exit(1);
  }
  console.warn(`${msg}: SKIPPED the asset-pipeline tests`);
  process.exit(0);
}
// A fresh base folder for pytest's tmp_path: the default (pytest-of-<user> under the system temp) has to be
// listed first, which sandboxed sessions refuse (PermissionError on every tmp_path test).
const basetemp = mkdtempSync(join(tmpdir(), 'wd-pytest-'));
const run = spawnSync(
  python,
  ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--basetemp', basetemp, '.', '../publish'],
  { cwd, stdio: 'inherit' },
);
rmSync(basetemp, { recursive: true, force: true });
process.exit(run.status ?? 1);
