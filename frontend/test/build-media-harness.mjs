// Test-only app build. Never deploy this dist: it exposes the existing engine for fault injection.
import * as esbuild from 'esbuild';
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import path from 'node:path';
await mkdir('dist/assets',{recursive:true});
await esbuild.build({entryPoints:['src/main.tsx'],bundle:true,outfile:'dist/assets/media-test.js',format:'esm',target:['chrome110','firefox115','safari16'],jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'},loader:{'.svg':'file','.woff2':'file'},plugins:[{
 name:'media-test-inspection',setup(build){build.onLoad({filter:/[\\/]webrtc[\\/]voiceEngine\.ts$/},async({path:filename})=>({contents:await readFile(filename,'utf8')+'\nObject.assign(window,{__concordTestVoice:voice,__concordTestVoiceStore:voiceStore});',loader:'ts',resolveDir:path.dirname(filename)}));}
}]});
const html=(await readFile('index.html','utf8')).replace('<!--CSS-->','<link rel="stylesheet" href="/assets/media-test.css">').replace('<!--JS-->','<script type="module" src="/assets/media-test.js"></script>');
await writeFile('dist/index.html',html);await cp('public','dist',{recursive:true});
console.log('Test-only media app built. Run node build.mjs to restore the production build.');
