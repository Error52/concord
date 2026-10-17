import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('first-account admin bootstrap is off by default in production and explicit elsewhere',()=>{
  for(const [mode,flag,expected] of [
    ['production',undefined,false],['development',undefined,true],['test',undefined,true],
    ['production','true',true],['production','1',true],['development','false',false],['test','0',false],
  ] as const){
    const env={...process.env,NODE_ENV:mode,DATABASE_URL:'postgres://test:test@127.0.0.1:9/no_connect_test',
      REDIS_URL:'redis://127.0.0.1:9/1',JWT_SECRET:'config-fixture-secret-123456789012345',BOOTSTRAP_FIRST_ADMIN:flag};
    if(flag===undefined)delete env.BOOTSTRAP_FIRST_ADMIN;
    const result=execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',
      `const {config}=await import('./src/config.ts');console.log(JSON.stringify(config.BOOTSTRAP_FIRST_ADMIN));`],{
      cwd:fileURLToPath(new URL('..',import.meta.url)),env,encoding:'utf8',timeout:15_000,
    });
    assert.equal(JSON.parse(result.trim()),expected,`${mode}, flag=${flag??'unset'}`);
  }
});
