import { describe, expect, it } from "vite-plus/test";
import { ProjectId, SidebarFolderId } from "./baseSchemas.ts";
import { resolveThreadSidebarPlacementProjectId } from "./sidebarPlacement.ts";

describe("resolveThreadSidebarPlacementProjectId", () => {
  const projectId = ProjectId.make("proj-workspace");

  it("falls back to workspace project when sidebarGroupId is absent (legacy)", () => {
    expect(resolveThreadSidebarPlacementProjectId({ projectId })).toBe("proj-workspace");
  });

  it("returns null for ungrouped sessions", () => {
    expect(
      resolveThreadSidebarPlacementProjectId({
        projectId,
        sidebarGroupId: null,
      }),
    ).toBeNull();
  });

  it("returns explicit shelf id when set", () => {
    expect(
      resolveThreadSidebarPlacementProjectId({
        projectId,
        sidebarGroupId: SidebarFolderId.make("proj-shelf"),
      }),
    ).toBe("proj-shelf");
  });
});
