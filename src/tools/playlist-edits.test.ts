import { describe, expect, test } from "bun:test";

import { MusicToolError } from "../types.js";
import { createPlaylistEditOperations } from "./playlist-edits.js";

type Info = {
  kind: "user" | "folder" | "subscription" | "system";
  applied: boolean;
  name?: string;
  folderId?: string;
};

function playlistPayload({
  kind,
  applied,
  name = "Road Trip",
  folderId = "",
}: Info): string {
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

describe("createPlaylistEditOperations.describe", () => {
  test("reports any kind of playlist, including ones that refuse edits", async () => {
    const { operations } = recordingRunner(
      playlistPayload({
        kind: "folder",
        applied: false,
        folderId: "AAAA1111BBBB2222",
      })
    );
    expect(await operations.describe("ABCDEF1234567890")).toEqual({
      id: "ABCDEF1234567890",
      name: "Road Trip",
      kind: "folder",
      isSmart: false,
      trackCount: 12,
      folderId: "AAAA1111BBBB2222",
      applied: false,
    });
  });
});

describe("createPlaylistEditOperations.delete", () => {
  test("deletes a user playlist and returns what it deleted", async () => {
    const { scripts, operations } = recordingRunner(
      playlistPayload({ kind: "user", applied: true })
    );
    const info = await operations.delete("ABCDEF1234567890");
    expect(info).toMatchObject({
      id: "ABCDEF1234567890",
      name: "Road Trip",
      trackCount: 12,
    });
    // The kind check runs inside the delete script, so a stale describe cannot delete a folder.
    expect(scripts[0]).toContain('if {"user"} contains pKind then');
  });

  test("refuses folders, subscriptions, and built-in playlists", async () => {
    for (const kind of ["folder", "subscription", "system"] as const) {
      const { operations } = recordingRunner(
        playlistPayload({ kind, applied: false })
      );
      const error = await errorOf(operations.delete("ABCDEF1234567890"));
      expect(error.code).toBe("validation_error");
      expect(error.message).toStartWith('"Road Trip" is a');
    }
  });

  test("reports script_error when Music did not apply the delete", async () => {
    const { operations } = recordingRunner(
      playlistPayload({ kind: "user", applied: false })
    );
    const error = await errorOf(operations.delete("ABCDEF1234567890"));
    expect(error.code).toBe("script_error");
    expect(error.message).toBe('Music did not delete "Road Trip".');
  });
});

describe("createPlaylistEditOperations.rename", () => {
  test("escapes the new name and returns the renamed playlist", async () => {
    const { scripts, operations } = recordingRunner(
      playlistPayload({ kind: "user", applied: true, name: 'Say "hi"\nnow' })
    );
    const info = await operations.rename("ABCDEF1234567890", 'Say "hi"\nnow');
    expect(info.name).toBe('Say "hi"\nnow');
    expect(scripts[0]).toContain('set name of p to "Say \\"hi\\"\\nnow"');
  });

  test("renames folders as well as user playlists", async () => {
    const { operations } = recordingRunner(
      playlistPayload({ kind: "folder", applied: true, name: "New" })
    );
    expect(await operations.rename("ABCDEF1234567890", "New")).toMatchObject({
      kind: "folder",
      name: "New",
    });
  });

  test("refuses built-in and subscription playlists with validation_error", async () => {
    for (const kind of ["system", "subscription"] as const) {
      const { operations } = recordingRunner(
        playlistPayload({ kind, applied: false })
      );
      const error = await errorOf(operations.rename("ABCDEF1234567890", "New"));
      expect(error.code).toBe("validation_error");
      expect(error.message).toStartWith('"Road Trip" ');
    }
  });

  test("maps an unknown ID to not_found", async () => {
    const { operations } = recordingRunner('{"found":false}');
    const error = await errorOf(operations.rename("ABCDEF1234567890", "New"));
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("No playlist has the ID ABCDEF1234567890.");
  });
});
