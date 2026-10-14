import * as z from "zod/v4";

import { escapeAppleScriptString } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runAppleScript } from "../applescript/runner.js";
import type { ExecFn } from "../applescript/runner.js";
import { buildScript } from "../applescript/templates.js";
import { persistentIdSchema } from "../config.js";
import { defineTool, IDEMPOTENT_WRITE_ANNOTATIONS } from "../tool-contracts.js";
import type { ToolSchemaOutput } from "../tool-contracts.js";
import { MusicToolError } from "../types.js";

const updateTrackInputSchema = z
  .object({
    disliked: z
      .boolean()
      .optional()
      .describe(
        "Mark or unmark the track as disliked. true also clears favorited."
      ),
    favorited: z
      .boolean()
      .optional()
      .describe(
        "Mark or unmark the track as a favorite. true also clears disliked."
      ),
    rating: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("Star rating from 0 to 5. 0 clears the rating."),
    trackId: persistentIdSchema.describe(
      "Persistent track ID from music.search_library, music.find_tracks, or music.get_playlist_tracks."
    ),
  })
  .refine(
    (input) =>
      input.favorited !== undefined ||
      input.disliked !== undefined ||
      input.rating !== undefined,
    { message: "Give at least one of favorited, disliked, or rating." }
  )
  .refine((input) => !(input.favorited === true && input.disliked === true), {
    message: "A track cannot be both favorited and disliked.",
  });
const updateTrackOutputSchema = z.object({
  disliked: z.boolean().describe("True when the track is disliked."),
  favorited: z.boolean().describe("True when the track is a favorite."),
  rating: z
    .number()
    .int()
    .describe(
      "Star rating from 0 to 5, rounded. Music may derive it from the album rating."
    ),
  trackId: z.string().describe("Persistent track ID."),
});

type TrackUpdate = ToolSchemaOutput<typeof updateTrackInputSchema>;
type TrackFlag = "favorited" | "disliked";
/** Property writes in Music's units: booleans for the flags, 0-100 for rating. */
export type TrackWrites = Partial<Record<TrackFlag, boolean>> & {
  rating?: number;
};

/** Turn a request into Music property writes, clearing the opposite flag of one set to true. */
export const planTrackWrites = ({
  favorited,
  disliked,
  rating,
}: TrackUpdate): TrackWrites => {
  const writes: TrackWrites = {};
  if (favorited !== undefined) {
    writes.favorited = favorited;
  } else if (disliked === true) {
    writes.favorited = false;
  }
  if (disliked !== undefined) {
    writes.disliked = disliked;
  } else if (favorited === true) {
    writes.disliked = false;
  }
  if (rating !== undefined) {
    writes.rating = rating * 20;
  }
  return writes;
};

const updateTrackScriptResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    disliked: z.boolean(),
    favorited: z.boolean(),
    found: z.literal(true),
    rating: z.number(),
  }),
]);

export const buildUpdateTrackScript = (
  trackId: string,
  writes: TrackWrites
): string => {
  // False flags go first so that, if Music clears one flag when another is set, the true one wins.
  const flagWrites = [false, true]
    .flatMap((value) =>
      (["favorited", "disliked"] as const).filter(
        (flag) => writes[flag] === value
      )
    )
    .map((flag) => `set ${flag} of t to ${writes[flag]}`);
  const ratingWrite =
    writes.rating === undefined ? [] : [`set rating of t to ${writes.rating}`];
  return buildScript(`
try
    tell application id "com.apple.Music"
        with timeout of 30 seconds
            set matches to (every track of library playlist 1 whose persistent ID is "${escapeAppleScriptString(trackId)}")
            if (count of matches) is 0 then return "{\\"found\\":false}"
            set t to item 1 of matches
            ${[...flagWrites, ...ratingWrite].join("\n            ")}
            return "{\\"found\\":true,\\"favorited\\":" & (favorited of t as text) & ",\\"disliked\\":" & (disliked of t as text) & ",\\"rating\\":" & (rating of t) & "}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try`);
};

export const createLibraryOperations = (execFn?: ExecFn) => ({
  async updateTrack(trackId: string, writes: TrackWrites) {
    const result = await runAppleScript(
      buildUpdateTrackScript(trackId, writes),
      40_000,
      execFn
    );
    const parsed = parseAppleScriptJson(
      result.stdout,
      updateTrackScriptResultSchema,
      "Music returned an invalid track update payload."
    );
    if (!parsed.found) {
      throw new MusicToolError(
        "not_found",
        `No library track has the ID ${trackId}.`
      );
    }
    return {
      disliked: parsed.disliked,
      favorited: parsed.favorited,
      rating: Math.round(parsed.rating / 20),
      trackId,
    };
  },
});

const libraryOperations = createLibraryOperations();

export const updateTrackTool = defineTool({
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  description:
    "Set a library track's favorite, dislike, or 0-5 star rating. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  dryRunResult(input) {
    const writes = planTrackWrites(input);
    return {
      disliked: writes.disliked ?? false,
      favorited: writes.favorited ?? false,
      rating: input.rating ?? 0,
      trackId: input.trackId,
    };
  },
  async handler(input) {
    const result = await libraryOperations.updateTrack(
      input.trackId,
      planTrackWrites(input)
    );
    return { logData: { trackId: input.trackId }, structuredContent: result };
  },
  inputSchema: updateTrackInputSchema,
  name: "music.update_track",
  outputSchema: updateTrackOutputSchema,
  writesRequired: true,
});
