// Production/dev bundler: esbuild → dist/ with content-hashed assets and a generated index.html.
import * as esbuild from 'esbuild';
import { mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = path.resolve('dist');
// Allows swapping a module at build time (used only by the sandbox E2E harness).
const aliases = process.env.CONCORD_ALIAS ? JSON.parse(process.env.CONCORD_ALIAS) : {};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const writeHtml = async (result) => {
  const outputs = Object.keys(result.metafile.outputs);
  const js = outputs.find((o) => o.endsWith('.js') && !o.endsWith('.map'));
  const css = outputs.find((o) => o.endsWith('.css') && !o.endsWith('.map'));
  const tpl = await readFile('index.html', 'utf8');
  const html = tpl
    .replace('<!--CSS-->', css ? `<link rel="stylesheet" href="/${path.relative(outdir, css).split(path.sep).join('/')}" />` : '')
    .replace('<!--JS-->', `<script type="module" src="/${path.relative(outdir, js).split(path.sep).join('/')}"></script>`);
  await writeFile(path.join(outdir, 'index.html'), html);
};

const options = {
  entryPoints: ['src/main.tsx'],
  bundle: true,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  outdir: path.join(outdir, 'assets'),
  entryNames: '[name]-[hash]',
  format: 'esm',
  target: ['chrome110', 'firefox115', 'safari16'],
  jsx: 'automatic',
  sourcemap: true,
  minify: !watch,
  metafile: true,
  alias: aliases,
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  loader: { '.svg': 'file', '.woff2': 'file' },
  logLevel: 'info',
  plugins: [
    {
      name: 'html',
      setup: (b) =>
        b.onEnd(async (r) => {
          if (r.errors.length === 0) await writeHtml(r);
        }),
    },
  ],
};

await cp('public', outdir, { recursive: true }).catch(() => undefined);

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
