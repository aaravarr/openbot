import type { LogChannel } from "../api/types";
import { channelLabel, channelModifier, channelSubtitle } from "../lib/format";

export function LogChannelBadge({ channel }: { channel: LogChannel | undefined }) {
  const mod = channelModifier(channel);
  return (
    <span className={`log-channel log-channel--${mod}`} title={channelSubtitle(channel)}>
      {channelLabel(channel)}
    </span>
  );
}

export function LogChannelPair({
  channels,
}: {
  channels: ReadonlyArray<LogChannel | undefined>;
}) {
  return (
    <span className="log-pair">
      {channels.map((channel, index) => (
        <LogChannelBadge key={`${channel ?? "hop"}-${String(index)}`} channel={channel} />
      ))}
    </span>
  );
}
