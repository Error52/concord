import {test} from 'node:test';
import assert from 'node:assert/strict';
import {composerRetryNonce,getComposerDraft,rememberComposerSend,setComposerDraft,restoreComposerDraft} from '../src/state/composerDrafts';

test('drafts survive channel and thread navigation without crossing accounts',()=>{
 setComposerDraft('alice:general:','Channel draft');setComposerDraft('alice:general:thread','Thread draft');setComposerDraft('bob:general:','Bob draft');
 assert.equal(getComposerDraft('alice:general:'),'Channel draft');assert.equal(getComposerDraft('alice:general:thread'),'Thread draft');assert.equal(getComposerDraft('bob:general:'),'Bob draft');
 setComposerDraft('alice:general:','');assert.equal(getComposerDraft('alice:general:'),'');assert.equal(getComposerDraft('alice:general:thread'),'Thread draft');
});

test('a failed send restores its original draft only when no newer text exists',()=>{
 setComposerDraft('late:channel:','');restoreComposerDraft('late:channel:','Failed original');assert.equal(getComposerDraft('late:channel:'),'Failed original');
 setComposerDraft('late:channel:','New draft after navigation');restoreComposerDraft('late:channel:','Failed original');assert.equal(getComposerDraft('late:channel:'),'New draft after navigation');
});

test('a reopened composer retains the failed retry nonce only for the same account and payload',()=>{
 rememberComposerSend('alice:retry:','payload','original-nonce',false);
 assert.equal(composerRetryNonce('alice:retry:','payload'),'original-nonce');assert.equal(composerRetryNonce('bob:retry:','payload'),undefined);assert.equal(composerRetryNonce('alice:retry:','different'),undefined);
 rememberComposerSend('alice:retry:','different','other-nonce',true);assert.equal(composerRetryNonce('alice:retry:','payload'),'original-nonce');
 rememberComposerSend('alice:retry:','payload','original-nonce',true);assert.equal(composerRetryNonce('alice:retry:','payload'),undefined);
});

test('multiple uncertain sends retain each payload nonce until that send succeeds',()=>{
 const key='alice:multiple-uncertain:';
 rememberComposerSend(key,'first payload','first-nonce',false);
 rememberComposerSend(key,'second payload','second-nonce',false);
 assert.equal(composerRetryNonce(key,'first payload'),'first-nonce');
 assert.equal(composerRetryNonce(key,'second payload'),'second-nonce');
 rememberComposerSend(key,'second payload','second-nonce',true);
 assert.equal(composerRetryNonce(key,'second payload'),undefined);
 assert.equal(composerRetryNonce(key,'first payload'),'first-nonce');
});

test('late results affect only their own payload and matching nonce',()=>{
 const key='alice:late-multiple:';
 rememberComposerSend(key,'older payload','older-nonce',false);
 rememberComposerSend(key,'newer payload','newer-nonce',false);
 rememberComposerSend(key,'newer payload','newer-nonce',true);
 rememberComposerSend(key,'older payload','older-nonce',false);
 assert.equal(composerRetryNonce(key,'newer payload'),undefined);
 assert.equal(composerRetryNonce(key,'older payload'),'older-nonce');
 rememberComposerSend(key,'older payload','different-nonce',true);
 assert.equal(composerRetryNonce(key,'older payload'),'older-nonce');
});

test('uncertain send cache remains bounded across channels and payloads',()=>{
 const key='alice:bounded:';
 for(let i=0;i<129;i++)rememberComposerSend(key,`payload-${i}`,`nonce-${i}`,false);
 assert.equal(composerRetryNonce(key,'payload-0'),undefined);
 assert.equal(composerRetryNonce(key,'payload-1'),'nonce-1');
 assert.equal(composerRetryNonce(key,'payload-128'),'nonce-128');
});
