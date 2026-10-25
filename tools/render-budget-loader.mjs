import { readFile } from 'node:fs/promises';
import ts from '../node_modules/typescript/lib/typescript.js';

// The CPU harness needs neither Vite's native bundler nor a browser. Production still uses Vite.
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return {
    shortCircuit: true,
    format: 'module',
    source: ts.transpileModule(source, {
      fileName: url,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
  };
}
