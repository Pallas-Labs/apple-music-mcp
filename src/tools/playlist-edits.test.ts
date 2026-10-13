import { describe, expect, test } from "bun:test";
import { MusicToolError } from "../types.js";
import { buildPlaylistScript, createPlaylistEditOperations } from "./playlist-edits.js";

type Info = {
  kind: "user" | "folder" | "subscription" | "system";
  applied: boolean;
  name?: string;
  folderId?: string;
};

function playlistPayload({ kind, applied, name = "Road Trip", folderId = "" }: Info): string {
  return JSON.stringify({
    found: true,
    id: "ABCDEF1234567890",
    name,
    kind,
    isSmart: false,
    trackCount: 12,
    folderId,
    applied,
  });
}

function recordingRunner(stdout: string) {
  const scripts: string[] = [];
  const operations = createPlaylistEditOperations(async (script) => {
    scripts.push(script);
    return { stdout, stderr: "" };
  });
  return { scripts, operations };
}

async function errorOf(promise: Promise<unknown>): Promise<MusicToolError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MusicToolError);
  return error as MusicToolError;
}

describe("buildPlaylistScript", () => {
  test("describes without editing when no edit is given", () => {
    const script = buildPlaylistScript("ABCDEF1234567890");
    expect(script).toContain('every playlist whose persistent ID is "ABCDEF1234567890"');
    expect(script).toContain("if {} contains pKind then");
  });

  test("edits only the kinds that allow a rename", () => {
    const script = buildPlaylistScript("ABCDEF1234567890", {
      kind: "rename",
      statements: 'set name of p to "x"',
    });
    expect(script).toContain('if {"user", "folder"} contains pKind then');
  });
});

describe("createPlaylistEditOperations.rename", () => {
  test("escapes the new name and returns the renamed playlist", async () => {
    const { scripts, operations } = recordingRunner(
      playlistPayload({ kind: "user", applied: true, name: 'Say "hi"\nnow' }),
    );
    const info = await operations.rename("ABCDEF1234567890", 'Say "hi"\nnow');
    expect(info.name).toBe('Say "hi"\nnow');
    expect(scripts[0]).toContain('set name of p to "Say \\"hi\\"\\nnow"');
  });

  test("refuses built-in and subscription playlists with validation_error", async () => {
    for (const kind of ["system", "subscription"] as const) {
      const { operations } = recordingRunner(playlistPayload({ kind, applied: false }));
      const error = await errorOf(operations.rename("ABCDEF1234567890", "New"));
      expect(error.code).toBe("validation_error");
      expect(error.message).toStartWith('"Road Trip" ');
    }
  });

  test("maps an unknown ID to not_found", async () => {
    const { operations } = recordingRunner('{"found":false}');
    const error = await errorOf(operations.rename("ABCDEF1234567890", "New"));
    expect(error.code).toBe("not_found");
  });
});
