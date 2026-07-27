import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Beta settings. Auto-settle was retired from the product surface: Archive is
 * the only soft-done path (ChatGPT / Claude Desktop parity). Keep this panel
 * for future opt-in experiments.
 */
export function BetaSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          title="No beta toggles right now"
          description="Settled / auto-settle was removed from the chat list in favor of Archive chat. New experiments will show up here."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
