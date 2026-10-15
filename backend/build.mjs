// Bundles the backend into dist/ (dependencies stay external, installed via npm in the image).
// Type checking is a separate step: `npm run typecheck`.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: { index: 'src/index.ts', 'seed-cli': 'src/db/seed-cli.ts', 'migrate-cli': 'src/db/migrate-cli.ts', 'admin-cli': 'src/db/admin-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
