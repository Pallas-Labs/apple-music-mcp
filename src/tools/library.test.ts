import { describe, expect, test } from "bun:test";
import { MusicToolError } from "../types.js";
import {
  buildUpdateTrackScript,
  createLibraryOperations,
  planTrackWrites,
  updateTrackTool,
} from "./library.js";

const TRACK_ID = "AAAABBBBCCCCDDDD";

describe("music.update_track input", () => {
  test("requires a change and rejects contradictory or out-of-range values", () => {
    const schema = updateTrackTool.inputSchema;
    expect(schema.safeParse({ trackId: TRACK_ID }).success).toBe(false);
    expect(schema.safeParse({ trackId: TRACK_ID, favorited: true, disliked: true }).success).toBe(
      false,
    );
    expect(schema.safeParse({ trackId: TRACK_ID, rating: 6 }).success).toBe(false);
    expect(schema.safeParse({ trackId: TRACK_ID, rating: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ trackId: TRACK_ID, rating: 0 }).success).toBe(true);
    expect(schema.safeParse({ trackId: TRACK_ID, favorited: true, disliked: false }).success).toBe(
      true,
    );
  });
});

describe("planTrackWrites", () => {
  test("clears the opposite flag when one is set to true", () => {
    expect(planTrackWrites({ trackId: TRACK_ID, favorited: true })).toEqual({
      favorited: true,
      disliked: false,
    });
    expect(planTrackWrites({ trackId: TRACK_ID, disliked: true })).toEqual({
      favorited: false,
      disliked: true,
    });
  });

  test("leaves the other flag alone when one is cleared, and maps stars to 0-100", () => {
    expect(planTrackWrites({ trackId: TRACK_ID, favorited: false, rating: 4 })).toEqual({
      favorited: false,
      rating: 80,
    });
  });
});

describe("buildUpdateTrackScript", () => {
  test("writes false flags before true ones, then the rating", () => {
    const script = buildUpdateTrackScript(TRACK_ID, {
      favorited: true,
      disliked: false,
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
    const operations = createLibraryOperations(async () => ({
      stdout: '{"found":true,"favorited":true,"disliked":false,"rating":70}',
      stderr: "",
    }));
    expect(await operations.updateTrack(TRACK_ID, { favorited: true })).toEqual({
      trackId: TRACK_ID,
      favorited: true,
      disliked: false,
      rating: 4,
    });
  });

  test("maps an unknown track ID to not_found", async () => {
    const operations = createLibraryOperations(async () => ({
      stdout: '{"found":false}',
      stderr: "",
    }));
    const error = await operations
      .updateTrack(TRACK_ID, { rating: 20 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicToolError);
    expect((error as MusicToolError).code).toBe("not_found");
  });
});
