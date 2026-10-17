import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const bash=spawnSync('bash',['--version']);
test('backup publishes complete sets only and restarts a quiesced backend even when pg_dump fails',{skip:bash.status!==0?'Bash is required':false},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'concord-backup-'));
 try{
  await mkdir(path.join(root,'scripts'));await mkdir(path.join(root,'bin'));
  await copyFile(new URL('../scripts/backup.sh',import.meta.url),path.join(root,'scripts/backup.sh'));
  await writeFile(path.join(root,'bin/docker'),`#!/usr/bin/env bash
echo "$*" >> "$BACKUP_TRACE"
case "$*" in
 'compose exec -T backend printenv STORAGE_DRIVER') echo local ;;
 'compose ps '*) echo test-backend ;;
 'compose exec -T postgres '*) [ "$FAIL_DUMP" != 1 ] || exit 23; printf 'CREATE TABLE backup_test(id int);\\n' ;;
 'compose exec -T backend tar '*) tar -czf - --files-from /dev/null ;;
 'compose run '*) tar -czf - --files-from /dev/null ;;
esac
`,{mode:0o755});
  const trace=path.join(root,'trace.log'),env={...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,BACKUP_TRACE:trace};
  const run=(fail,...args)=>spawnSync('bash',['scripts/backup.sh',...args],{cwd:root,env:{...env,FAIL_DUMP:fail?'1':'0'},encoding:'utf8'});
  const failed=run(true,'--quiesce');assert.notEqual(failed.status,0);assert.doesNotMatch(failed.stdout,/Saved:/);
  assert.deepEqual(await readdir(path.join(root,'backups')),[]);
  assert.match(await readFile(trace,'utf8'),/compose start backend/,'failure restores service');
  const passed=run(false,'--quiesce');assert.equal(passed.status,0,passed.stderr);assert.match(passed.stdout,/Saved:/);
  const sets=await readdir(path.join(root,'backups'));assert.equal(sets.length,1);
  assert.deepEqual((await readdir(path.join(root,'backups',sets[0]))).sort(),['database.sql.gz','metadata.txt','uploads.tar.gz']);
 }finally{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('concord-backup-'));
  await rm(root,{recursive:true,force:true});
 }
});
