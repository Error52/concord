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
