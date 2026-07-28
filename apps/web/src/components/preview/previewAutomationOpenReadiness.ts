import type {
  PreviewAutomationOpenInput,
  PreviewSessionSnapshot,
} from "@toolport-studio/contracts";

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}
