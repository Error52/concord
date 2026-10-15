// Optional A/B benchmark against a supplied previous source snapshot.
import * as esbuild from 'esbuild';
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.env.REFERENCE_DIR??'../../benchmark-reference/concord/frontend');
const dist=path.join(root,'dist');await mkdir(path.join(dist,'assets'),{recursive:true});
await esbuild.build({entryPoints:[path.join(root,'src/main.tsx')],nodePaths:[path.resolve('node_modules')],bundle:true,outfile:path.join(dist,'assets/main.js'),format:'esm',target:['chrome110','firefox115','safari16'],jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'},loader:{'.svg':'file','.woff2':'file'}});
const html=(await readFile(path.join(root,'index.html'),'utf8')).replace('<!--CSS-->','<link rel="stylesheet" href="/assets/main.css">').replace('<!--JS-->','<script type="module" src="/assets/main.js"></script>');
await writeFile(path.join(dist,'index.html'),html);await cp(path.join(root,'public'),dist,{recursive:true});
console.log('Reference snapshot built:',root);
