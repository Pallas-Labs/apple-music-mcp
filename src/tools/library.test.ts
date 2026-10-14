import { describe, expect, mock, test } from "bun:test";

import type { ExecFn } from "../applescript/runner.js";
import { MusicToolError } from "../types.js";
import {
  buildUpdateTrackScript,
  createLibraryOperations,
  planTrackWrites,
  updateTrackTool,
} from "./library.js";

const TRACK_ID = "AAAABBBBCCCCDDDD";

const execReturning = (stdout: string) =>
  mock<ExecFn>().mockResolvedValue({ stderr: "", stdout });

const errorOf = async <T>(promise: Promise<T>): Promise<MusicToolError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MusicToolError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the promise to reject with a MusicToolError.");
};

describe("music.update_track input", () => {
  test("requires a change and rejects contradictory or out-of-range values", () => {
    const schema = updateTrackTool.inputSchema;
    expect(schema.safeParse({ trackId: TRACK_ID }).success).toBe(false);
    expect(
      schema.safeParse({ disliked: true, favorited: true, trackId: TRACK_ID })
        .success
    ).toBe(false);
    expect(schema.safeParse({ rating: 6, trackId: TRACK_ID }).success).toBe(
      false
    );
    expect(schema.safeParse({ rating: 2.5, trackId: TRACK_ID }).success).toBe(
      false
    );
    expect(schema.safeParse({ rating: 0, trackId: TRACK_ID }).success).toBe(
      true
    );
    expect(
      schema.safeParse({ disliked: false, favorited: true, trackId: TRACK_ID })
        .success
    ).toBe(true);
  });
});

describe("planTrackWrites", () => {
  test("clears the opposite flag when one is set to true", () => {
    expect(planTrackWrites({ favorited: true, trackId: TRACK_ID })).toEqual({
      disliked: false,
      favorited: true,
    });
    expect(planTrackWrites({ disliked: true, trackId: TRACK_ID })).toEqual({
      disliked: true,
      favorited: false,
    });
  });

  test("leaves the other flag alone when one is cleared, and maps stars to 0-100", () => {
    expect(
      planTrackWrites({ favorited: false, rating: 4, trackId: TRACK_ID })
    ).toEqual({
      favorited: false,
      rating: 80,
    });
  });
});

describe("buildUpdateTrackScript", () => {
  test("writes false flags before true ones, then the rating", () => {
    const script = buildUpdateTrackScript(TRACK_ID, {
      disliked: false,
      favorited: true,
      rating: 60,
    });
    const clear = script.indexOf("set disliked of t to false");
    const set = script.indexOf("set favorited of t to true");
    const rating = script.indexOf("set rating of t to 60");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(set);
    expect(set).toBeLessThan(rating);
    expect(script).not.toContain("set favorited of t to false");
  });

  test("escapes the track ID", () => {
    const script = buildUpdateTrackScript('X"Y', { favorited: true });
    expect(script).toContain('whose persistent ID is "X\\"Y"');
  });
});

describe("createLibraryOperations.updateTrack", () => {
  test("reports the read-back state with the rating in rounded stars", async () => {
    const operations = createLibraryOperations(
      execReturning(
        '{"found":true,"favorited":true,"disliked":false,"rating":70}'
      )
    );
    expect(await operations.updateTrack(TRACK_ID, { favorited: true })).toEqual(
      {
        disliked: false,
        favorited: true,
        rating: 4,
        trackId: TRACK_ID,
      }
    );
  });

  test("maps an unknown track ID to not_found", async () => {
    const operations = createLibraryOperations(
      execReturning('{"found":false}')
    );
    const error = await errorOf(
      operations.updateTrack(TRACK_ID, { rating: 20 })
    );
    expect(error.code).toBe("not_found");
  });
});
