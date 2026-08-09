// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { isHostWindows } from "@toolport-studio/shared/hostProcess";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(NodeProcess.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

// Windows hands back an 8.3 short path (`C:\Users\RUNNER~1\...`) whenever the temp directory has a
// component longer than eight characters, which is the case on CI where the runner profile is
// `runneradmin`. That matters here because the two realpath implementations in play disagree about
// short names: `node:fs/promises.realpath`, which this service uses, expands them, while
// `fs.realpathSync` and Effect's `FileSystem.realPath` leave them alone. A fixture left in short
// form therefore makes every resolved-path assertion compare two different spellings of the same
// file. Normalising once, here, keeps both spellings out of the tests entirely.
const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
  return yield* Effect.promise(() => NodeFSP.realpath(directory));
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        if (yield* isHostWindows) return;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("rejects writes whose file symlink resolves outside the workspace root", () =>
      Effect.gen(function* () {
        if (yield* isHostWindows) return;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const outsidePath = path.join(outsideDir, "secret.txt");
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(outsidePath, path.join(cwd, "linked-secret.txt"));

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "linked-secret.txt", contents: "pwned\n" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(outsidePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        const outsideContents = yield* fileSystem.readFileString(outsidePath).pipe(Effect.orDie);
        expect(outsideContents).toBe("outside\n");
      }),
    );

    it.effect("rejects writes whose directory symlink resolves outside the workspace root", () =>
      Effect.gen(function* () {
        if (yield* isHostWindows) return;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* fileSystem.symlink(outsideDir, path.join(cwd, "out"));

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "out/pwned.txt", contents: "pwned\n" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(outsideDir);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "out/pwned.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        const createdOutside = yield* fileSystem
          .stat(path.join(outsideDir, "pwned.txt"))
          .pipe(Effect.orElseSucceed(() => null));
        expect(createdOutside).toBeNull();
      }),
    );

    it.effect("replaces existing files atomically and leaves no temp artifacts", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const targetPath = path.join(cwd, "plans/effect-rpc.md");
        yield* writeTextFile(cwd, "plans/effect-rpc.md", "# Old\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# New\n",
        });

        const saved = yield* fileSystem.readFileString(targetPath).pipe(Effect.orDie);
        expect(saved).toBe("# New\n");

        const dirEntries = yield* fileSystem
          .readDirectory(path.dirname(targetPath), { recursive: true })
          .pipe(Effect.orDie);
        const leftovers = dirEntries.filter((entry) => !entry.endsWith("effect-rpc.md"));
        expect(leftovers).toEqual([]);
      }),
    );
  });
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystem source shape", (it) => {
  it("stages workspace writes through atomic write, not in-place truncation", () => {
    const source = NodeFS.readFileSync(
      new URL("./WorkspaceFileSystem.ts", import.meta.url),
      "utf8",
    );
    const writeFnStart = source.indexOf('"WorkspaceFileSystem.writeFile"');
    expect(writeFnStart).toBeGreaterThanOrEqual(0);
    const writeFnBody = source.slice(writeFnStart, writeFnStart + 6_000);

    const usesAtomicHelper =
      writeFnBody.includes("writeFileStringAtomically") || writeFnBody.includes("atomicWrite");
    const writesInPlaceToTarget = /writeFileString\(\s*target\.absolutePath/.test(writeFnBody);

    expect(usesAtomicHelper).toBe(true);
    expect(writesInPlaceToTarget).toBe(false);
  });
});
