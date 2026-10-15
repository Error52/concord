import { createStore, useStoreSelector } from '../../state/store';
import { voiceStore } from '../../webrtc/voiceEngine';

export interface StageState {
  focus: { identity: string; source: 'camera' | 'screen' } | null;
  hideParticipants: boolean;
  /** Show the focused video in the floating mini-player even on the stage page. */
  popped: boolean;
}

export const stageStore = createStore<StageState>({ focus: null, hideParticipants: false, popped: false });
export const useStage = <T,>(sel: (s: StageState) => T): T => useStoreSelector(stageStore, sel);

// Drop focus when the call ends or the focused participant/stream disappears.
voiceStore.subscribe(() => {
  const f = stageStore.get().focus;
  if (!f) return;
  const v = voiceStore.get();
  const p = v.participants[f.identity];
  if (v.status === 'idle' || !p || (f.source === 'screen' && !p.hasScreen) || (f.source === 'camera' && !p.hasCamera)) {
    stageStore.set({ focus: null, popped: false });
  }
});
