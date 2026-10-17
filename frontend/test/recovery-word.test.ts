import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRecoveryWord,recoveryWordError} from '../src/utils/recoveryWord';

test('recovery accepts copied Unicode width, case and whitespace variants',()=>{
  assert.equal(normalizeRecoveryWord('  ＡＭＢＥＲ\u00a0\tOrchid  42\n'),'amber orchid 42');
  assert.equal(recoveryWordError('Amber Orchid 42','  ＡＭＢＥＲ  orchid 42 ','different password'),null);
  assert.equal(recoveryWordError('Straße River 42','STRASSE river 42','different password'),null);
  assert.equal(normalizeRecoveryWord('ΟΣ RIVER PHRASE'),normalizeRecoveryWord('οσ river phrase'));
});

test('seven normalized Cyrillic characters are rejected while eight are accepted',()=>{
  assert.match(recoveryWordError('радужны','радужны','password123')??'',/минимум 8/);
  assert.equal(recoveryWordError('Радужный',' радужный ','password123'),null);
  assert.equal(recoveryWordError('радужныи\u0306','РАДУЖНЫЙ','password123'),null);
});

test('padding cannot bypass the eight-character normalized requirement',()=>{
  assert.match(recoveryWordError('      tiny        ','tiny','password123')??'',/минимум 8/);
  assert.match(recoveryWordError('  РАДУЖНЫ\t\n','радужны','password123')??'',/минимум 8/);
});

test('visually equivalent password reuse is rejected even when confirmation matches',()=>{
  assert.match(recoveryWordError(' ＳＥＣＲＥＴ phrase 42 ','secret phrase 42','Secret   PHRASE 42')??'',/отличаться от пароля/);
  assert.match(recoveryWordError('amber orchid 42','amber orchard 42','password123')??'',/не совпадают/);
});

test('recovery word length has a bounded upper limit',()=>{
  assert.equal(recoveryWordError('x'.repeat(256),'x'.repeat(256),'password123'),null);
  assert.match(recoveryWordError('x'.repeat(257),'x'.repeat(257),'password123')??'',/максимум 256/);
});
