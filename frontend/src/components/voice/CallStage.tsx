import { Stage } from './Stage';

/** DM call view shown above the DM conversation while a call is active. */
export function CallStage({ channelId }: { channelId: string }) {
  return <Stage channelId={channelId} serverId={null} mode="call" />;
}
