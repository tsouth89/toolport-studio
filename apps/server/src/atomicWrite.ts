import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  /**
   * Mode bits to apply to the staged file before the rename. Without this, a
   * fresh temp file inherits the default creation mode and overwriting an
   * executable (0755) or private (0600) file silently strips those bits.
   */
  readonly mode?: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      if (input.mode !== undefined) {
        yield* fs.chmod(tempPath, input.mode);
      }
      yield* fs.rename(tempPath, input.filePath);
    }),
  );
