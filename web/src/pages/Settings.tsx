import { DeliveryCard } from "../components/DeliveryCard";
import { GrokSkillCard } from "../components/GrokSkillCard";
import { LogSettingsCard } from "../components/LogSettingsCard";
import { TunnelCard } from "../components/TunnelCard";

/**
 * Independent settings page (#/settings): the config-type controls that used to
 * be scattered over the Dashboard and the Logs page. The Dashboard stays a
 * status page; the Logs page stays an observation page.
 */
export function Settings() {
  return (
    <>
      <div className="page-title-row">
        <h1>Settings</h1>
        <span className="sub">Delivery follow-up, recording, phone access, and the Grok Bot skill.</span>
      </div>
      <div className="grid grid--12">
        <DeliveryCard />
        <LogSettingsCard />
        <TunnelCard />
        <GrokSkillCard />
      </div>
    </>
  );
}
