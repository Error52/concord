import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRecoveryWord,recoveryWordError} from '../src/utils/recoveryWord';

test('recovery accepts copied Unicode width, case and whitespace variants',()=>{
  assert.equal(normalizeRecoveryWord('  ＡＭＢＥＲ\u00a0\tOrchid  42\n'),'amber orchid 42');
  assert.equal(recoveryWordError('Amber Orchid 42','  ＡＭＢＥＲ  orchid 42 ','different password'),null);
  assert.equal(recoveryWordError('Straße River 42','STRASSE river 42','different password'),null);
  assert.equal(normalizeRecoveryWord('ΟΣ RIVER PHRASE'),normalizeRecoveryWord('οσ river phrase'));
});

test('padding cannot bypass the recovery word length requirement',()=>{
  assert.match(recoveryWordError('      tiny        ','tiny','password123')??'',/минимум 12/);
});

test('visually equivalent password reuse is rejected even when confirmation matches',()=>{
  assert.match(recoveryWordError(' ＳＥＣＲＥＴ phrase 42 ','secret phrase 42','Secret   PHRASE 42')??'',/отличаться от пароля/);
  assert.match(recoveryWordError('amber orchid 42','amber orchard 42','password123')??'',/не совпадают/);
});

test('recovery word length has a bounded upper limit',()=>{
  assert.equal(recoveryWordError('x'.repeat(256),'x'.repeat(256),'password123'),null);
  assert.match(recoveryWordError('x'.repeat(257),'x'.repeat(257),'password123')??'',/максимум 256/);
});
