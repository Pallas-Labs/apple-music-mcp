import * as z from "zod/v4";
import { persistentIdSchema } from "../config.js";
import { runAppleScript } from "../applescript/runner.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { LibraryTrack, Track, TrackCriteria, TrackSortBy } from "../types.js";
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  defineTool,
  READ_ONLY_ANNOTATIONS,
  type ToolSchemaOutput,
} from "../tool-contracts.js";

export const FIND_TRACKS_CANDIDATE_CAP = 1_000;

function canonicalTrackId(trackId: string): string {
  return trackId.toUpperCase();
}

function toCanonicalTrackIdSet(trackIds: string[]): Set<string> {
  return new Set(trackIds.map(canonicalTrackId));
}

function hasDuplicateTrackIds(trackIds: string[]): boolean {
  return toCanonicalTrackIdSet(trackIds).size !== trackIds.length;
}

const libraryTrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string(),
  album: z.string(),
  genre: z.string(),
  duration: z.number(),
  year: z.number(),
  playCount: z.number(),
});

export const trackCriteriaShape = {
  nameQuery: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Case-insensitive substring match against track name."),
  artist: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Case-insensitive substring match against artist."),
  album: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Case-insensitive substring match against album."),
  genre: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Case-insensitive substring match against genre."),
  yearMin: z.number().int().min(0).max(9999).optional(),
  yearMax: z.number().int().min(0).max(9999).optional(),
  playCountMin: z.number().int().min(0).optional(),
  playCountMax: z.number().int().min(0).optional(),
  sortBy: z
    .enum(["name", "artist", "album", "year", "playCount"])
    .optional()
    .describe("Sort order for returned tracks."),
  limit: z.number().int().min(1).max(200).optional().describe("Max tracks to return (default 50)."),
} satisfies z.ZodRawShape;

export const trackCriteriaSchema = z.object(trackCriteriaShape).superRefine((criteria, context) => {
  const hasTextFilter = [criteria.nameQuery, criteria.artist, criteria.album, criteria.genre].some(
    (value) => value !== undefined && value.trim().length > 0,
  );
  const hasNumericFilter = [
    criteria.yearMin,
    criteria.yearMax,
    criteria.playCountMin,
    criteria.playCountMax,
  ].some((value) => value !== undefined);

  if (!hasTextFilter && !hasNumericFilter) {
    context.addIssue({
      code: "custom",
      message: "At least one track filter is required.",
    });
  }
  if (
    criteria.yearMin !== undefined &&
    criteria.yearMax !== undefined &&
    criteria.yearMin > criteria.yearMax
  ) {
    context.addIssue({
      code: "custom",
      message: "yearMin must be less than or equal to yearMax.",
    });
  }
  if (
    criteria.playCountMin !== undefined &&
    criteria.playCountMax !== undefined &&
    criteria.playCountMin > criteria.playCountMax
  ) {
    context.addIssue({
      code: "custom",
      message: "playCountMin must be less than or equal to playCountMax.",
    });
  }
});

const findTracksOutputSchema = {
  tracks: z.array(libraryTrackSchema),
  totalMatched: z.number(),
  limit: z.number(),
  scanned: z.number(),
  truncated: z.boolean(),
};
const getPlaylistTracksInputSchema = {
  playlistId: persistentIdSchema,
  offset: z.number().int().min(0).optional().describe("Start index (default 0)."),
  limit: z.number().int().min(1).max(100).optional().describe("Max tracks to return (default 50)."),
};
const getPlaylistTracksOutputSchema = {
  tracks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      artist: z.string(),
      album: z.string(),
      duration: z.number(),
    }),
  ),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
};
export const trackIdsSchema = z
  .array(persistentIdSchema)
  .min(1)
  .max(100)
  .refine((trackIds) => !hasDuplicateTrackIds(trackIds), {
    message: "Track IDs must be unique.",
  })
  .describe("Unique persistent IDs of tracks.");
const trackMutationInputSchema = {
  playlistId: persistentIdSchema,
  trackIds: trackIdsSchema,
};
const addTracksOutputSchema = {
  playlistId: z.string(),
  requested: z.number().int().min(0),
  added: z.number().int().min(0),
  addedTrackIds: z.array(z.string()),
  missingTrackIds: z.array(z.string()),
  failedTrackIds: z.array(z.string()),
};
const removeTracksOutputSchema = {
  playlistId: z.string(),
  requested: z.number().int().min(0),
  removed: z.number().int().min(0),
  removedTrackIds: z.array(z.string()),
  missingTrackIds: z.array(z.string()),
  failedTrackIds: z.array(z.string()),
};
const addTracksResultSchema = z.object(addTracksOutputSchema);
const removeTracksResultSchema = z.object(removeTracksOutputSchema);
const findTracksScriptResultSchema = z.object({
  tracks: z.array(libraryTrackSchema),
  scanned: z.number().int().min(0),
  truncated: z.boolean(),
});
const playlistTracksResultSchema = z.object(getPlaylistTracksOutputSchema);

export type FindTracksResult = ToolSchemaOutput<typeof findTracksOutputSchema>;
export type AddTracksResult = ToolSchemaOutput<typeof addTracksOutputSchema>;
export type RemoveTracksResult = ToolSchemaOutput<typeof removeTracksOutputSchema>;

export const findTracksTool = defineTool({
  name: "music.find_tracks",
  description:
    "Find library tracks by explicit criteria such as name, artist, album, genre, year, and play count.",
  inputSchema: trackCriteriaSchema,
  outputSchema: findTracksOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  writesRequired: false,
  async handler(criteria) {
    const result = await findTracks(criteria);
    return {
      structuredContent: result,
      logData: {
        totalMatched: result.totalMatched,
        returnedCount: result.tracks.length,
        scanned: result.scanned,
        truncated: result.truncated,
        sortBy: criteria.sortBy ?? "name",
      },
    };
  },
});

export const getPlaylistTracksTool = defineTool({
  name: "music.get_playlist_tracks",
  description: "Get tracks in a playlist. Supports pagination via offset/limit.",
  inputSchema: getPlaylistTracksInputSchema,
  outputSchema: getPlaylistTracksOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  writesRequired: false,
  async handler({ playlistId, offset, limit }) {
    const result = await getPlaylistTracks(playlistId, offset ?? 0, limit ?? 50);
    return {
      structuredContent: result,
      logData: { playlistId, trackCount: result.tracks.length, total: result.total },
    };
  },
});

export const addTracksToPlaylistTool = defineTool({
  name: "music.add_tracks_to_playlist",
  description: "Add tracks to a playlist by their persistent IDs.",
  inputSchema: trackMutationInputSchema,
  outputSchema: addTracksOutputSchema,
  annotations: ADDITIVE_WRITE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult({ playlistId, trackIds }) {
    return {
      playlistId,
      requested: trackIds.length,
      added: trackIds.length,
      addedTrackIds: trackIds,
      missingTrackIds: [],
      failedTrackIds: [],
    };
  },
  async handler({ playlistId, trackIds }) {
    const result = await addTracksToPlaylist(playlistId, trackIds);
    return {
      structuredContent: result,
      logData: {
        playlistId,
        requestedCount: result.requested,
        addedCount: result.added,
        missingCount: result.missingTrackIds.length,
        failedCount: result.failedTrackIds.length,
      },
    };
  },
});

export const removeTracksFromPlaylistTool = defineTool({
  name: "music.remove_tracks_from_playlist",
  description: "Remove every matching instance of tracks from a playlist by persistent ID.",
  inputSchema: trackMutationInputSchema,
  outputSchema: removeTracksOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  writesRequired: true,
  dryRunResult({ playlistId, trackIds }) {
    return {
      playlistId,
      requested: trackIds.length,
      removed: trackIds.length,
      removedTrackIds: trackIds,
      missingTrackIds: [],
      failedTrackIds: [],
    };
  },
  async handler({ playlistId, trackIds }) {
    const result = await defaultTrackOperations.removeTracksFromPlaylist(playlistId, trackIds);
    return {
      structuredContent: result,
      logData: {
        playlistId,
        requestedCount: result.requested,
        removedCount: result.removed,
        missingCount: result.missingTrackIds.length,
        failedCount: result.failedTrackIds.length,
      },
    };
  },
});

async function findTracksWithRunner(
  run: typeof runAppleScript,
  criteria: TrackCriteria,
): Promise<FindTracksResult> {
  const validatedCriteria = trackCriteriaSchema.parse(criteria);
  const seedQuery = pickTrackSearchSeed(validatedCriteria);
  const safeSeedQuery = escapeAppleScriptString(seedQuery ?? "");

  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 120 seconds
            if "${safeSeedQuery}" is not "" then
                set sourceTracks to (search library playlist 1 for "${safeSeedQuery}" only all)
            else
                set sourceTracks to tracks of library playlist 1
            end if

            set sourceCount to count of sourceTracks
            set scannedCount to sourceCount
            if scannedCount > ${FIND_TRACKS_CANDIDATE_CAP} then set scannedCount to ${FIND_TRACKS_CANDIDATE_CAP}
            set truncatedValue to "false"
            if sourceCount > scannedCount then set truncatedValue to "true"

            set trackRows to {}
            if scannedCount > 0 then
                repeat with i from 1 to scannedCount
                    set t to item i of sourceTracks
                    try
                        set trackId to persistent ID of t as text
                        set trackName to name of t as text
                        set trackArtist to artist of t as text
                        set trackAlbum to album of t as text
                        set trackGenre to genre of t as text
                        set trackDuration to duration of t
                        set trackYear to year of t
                        set trackPlayCount to played count of t

                        set end of trackRows to {trackId, trackName, trackArtist, trackAlbum, trackGenre, trackDuration, trackYear, trackPlayCount}
                    end try
                end repeat
            end if
            return "{\\"tracks\\":" & my jsonTracks(trackRows) & ",\\"scanned\\":" & scannedCount & ",\\"truncated\\":" & truncatedValue & "}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonTracks(rows)
    set serializedRows to {}
    repeat with row in rows
        set tId to item 1 of row
        set tName to item 2 of row
        set tArtist to item 3 of row
        set tAlbum to item 4 of row
        set tGenre to item 5 of row
        set tDuration to item 6 of row
        set tYear to item 7 of row
        set tPlayCount to item 8 of row
        set end of serializedRows to "{\\"id\\":\\"" & my jsonEscape(tId as text) & "\\",\\"name\\":\\"" & my jsonEscape(tName as text) & "\\",\\"artist\\":\\"" & my jsonEscape(tArtist as text) & "\\",\\"album\\":\\"" & my jsonEscape(tAlbum as text) & "\\",\\"genre\\":\\"" & my jsonEscape(tGenre as text) & "\\",\\"duration\\":" & tDuration & ",\\"year\\":" & tYear & ",\\"playCount\\":" & tPlayCount & "}"
    end repeat
    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to ","
    set json to serializedRows as text
    set AppleScript's text item delimiters to previousDelimiters
    return "[" & json & "]"
end jsonTracks`;

  const result = await run(buildScript(body), 120_000);

  const parsed = parseAppleScriptJsonOutput(
    result.stdout,
    findTracksScriptResultSchema,
    "Music returned an invalid find tracks payload.",
  );

  const sortBy = validatedCriteria.sortBy ?? "name";
  const limit = validatedCriteria.limit ?? 50;
  const sorted = parsed.tracks
    .filter((track) => matchesTrackCriteria(track, validatedCriteria))
    .sort(createTrackComparator(sortBy));

  return {
    tracks: sorted.slice(0, limit),
    totalMatched: sorted.length,
    limit,
    scanned: parsed.scanned,
    truncated: parsed.truncated,
  };
}

async function getPlaylistTracks(
  playlistId: string,
  offset: number,
  limit: number,
): Promise<{ tracks: Track[]; total: number; offset: number; limit: number }> {
  const safeId = escapeAppleScriptString(playlistId);
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 60 seconds
            set targetPlaylist to first user playlist whose persistent ID is "${safeId}"
            set allTracks to tracks of targetPlaylist
            set totalCount to count of allTracks
            set trackRows to {}
            set startIdx to ${offset + 1}
            set endIdx to ${offset} + ${limit}
            if endIdx > totalCount then set endIdx to totalCount
            if startIdx > totalCount then
                return "{\\"tracks\\":[],\\"total\\":" & totalCount & ",\\"offset\\":${offset},\\"limit\\":${limit}}"
            end if
            repeat with i from startIdx to endIdx
                set t to item i of allTracks
                try
                    set trackId to persistent ID of t as text
                    set trackName to name of t as text
                    set trackArtist to artist of t as text
                    set trackAlbum to album of t as text
                    set trackDuration to duration of t
                    set end of trackRows to {trackId, trackName, trackArtist, trackAlbum, trackDuration}
                end try
            end repeat
            return "{\\"tracks\\":" & my jsonTracks(trackRows) & ",\\"total\\":" & totalCount & ",\\"offset\\":${offset},\\"limit\\":${limit}}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonTracks(rows)
    set json to "["
    repeat with i from 1 to (count of rows)
        set row to item i of rows
        set tId to item 1 of row
        set tName to item 2 of row
        set tArtist to item 3 of row
        set tAlbum to item 4 of row
        set tDuration to item 5 of row
        set json to json & "{\\"id\\":\\"" & my jsonEscape(tId as text) & "\\",\\"name\\":\\"" & my jsonEscape(tName as text) & "\\",\\"artist\\":\\"" & my jsonEscape(tArtist as text) & "\\",\\"album\\":\\"" & my jsonEscape(tAlbum as text) & "\\",\\"duration\\":" & tDuration & "}"
        if i < (count of rows) then
            set json to json & ","
        end if
    end repeat
    return json & "]"
end jsonTracks`;

  const result = await runAppleScript(buildScript(body), 60_000);

  const parsed = parseAppleScriptJsonOutput(
    result.stdout,
    playlistTracksResultSchema,
    "Music returned an invalid playlist tracks payload.",
  );
  return parsed;
}

async function addTracksToPlaylistWithRunner(
  run: typeof runAppleScript,
  playlistId: string,
  trackIds: string[],
): Promise<AddTracksResult> {
  assertUniqueTrackIds(trackIds);
  const safePlaylistId = escapeAppleScriptString(playlistId);
  const idList = trackIds.map((id) => `"${escapeAppleScriptString(id)}"`).join(", ");
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 60 seconds
            set targetPlaylist to first user playlist whose persistent ID is "${safePlaylistId}"
            set trackIdList to {${idList}}
            set addedTrackIds to {}
            set missingTrackIds to {}
            set failedTrackIds to {}
            repeat with tid in trackIdList
                set targetTrack to missing value
                try
                    set targetTrack to first track of library playlist 1 whose persistent ID is tid
                on error
                    set end of missingTrackIds to (tid as text)
                end try
                if targetTrack is not missing value then
                    try
                        duplicate targetTrack to targetPlaylist
                        set end of addedTrackIds to (tid as text)
                    on error
                        set end of failedTrackIds to (tid as text)
                    end try
                end if
            end repeat
            return "{\\"playlistId\\":\\"${safePlaylistId}\\",\\"requested\\":" & (count of trackIdList) & ",\\"added\\":" & (count of addedTrackIds) & ",\\"addedTrackIds\\":" & my jsonStringArray(addedTrackIds) & ",\\"missingTrackIds\\":" & my jsonStringArray(missingTrackIds) & ",\\"failedTrackIds\\":" & my jsonStringArray(failedTrackIds) & "}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try`;

  const result = await run(buildScript(body), 60_000);

  const parsed = parseAppleScriptJsonOutput(
    result.stdout,
    addTracksResultSchema,
    "Music returned an invalid add tracks payload.",
  );
  const { classifiedIds, classificationSets } = validateTrackMutationClassifications(
    parsed,
    playlistId,
    trackIds,
    [parsed.addedTrackIds, parsed.missingTrackIds, parsed.failedTrackIds],
    "Music returned inconsistent add track results.",
  );
  const classificationCount = classificationSets.reduce((sum, ids) => sum + ids.size, 0);
  if (parsed.added !== parsed.addedTrackIds.length || classificationCount !== classifiedIds.size) {
    throw new MusicToolError("script_error", "Music returned inconsistent add track results.");
  }
  return parsed;
}

async function removeTracksFromPlaylistWithRunner(
  run: typeof runAppleScript,
  playlistId: string,
  trackIds: string[],
): Promise<RemoveTracksResult> {
  assertUniqueTrackIds(trackIds);
  const safePlaylistId = escapeAppleScriptString(playlistId);
  const idList = trackIds.map((id) => `"${escapeAppleScriptString(id)}"`).join(", ");
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 60 seconds
            set targetPlaylist to first user playlist whose persistent ID is "${safePlaylistId}"
            set targetTrackIds to {${idList}}
            set removedCount to 0
            set removedTrackIds to {}
            set failedTrackIds to {}
            set playlistTracks to tracks of targetPlaylist
            repeat with i from (count of playlistTracks) to 1 by -1
                set t to item i of playlistTracks
                try
                    set trackId to persistent ID of t as text
                    if targetTrackIds contains trackId then
                        try
                            delete t
                            set removedCount to removedCount + 1
                            if removedTrackIds does not contain trackId then
                                set end of removedTrackIds to trackId
                            end if
                        on error
                            if failedTrackIds does not contain trackId then
                                set end of failedTrackIds to trackId
                            end if
                        end try
                    end if
                end try
            end repeat
            set missingTrackIds to {}
            repeat with tid in targetTrackIds
                set trackId to tid as text
                if removedTrackIds does not contain trackId and failedTrackIds does not contain trackId then
                    set end of missingTrackIds to trackId
                end if
            end repeat
            return "{\\"playlistId\\":\\"${safePlaylistId}\\",\\"requested\\":" & (count of targetTrackIds) & ",\\"removed\\":" & removedCount & ",\\"removedTrackIds\\":" & my jsonStringArray(removedTrackIds) & ",\\"missingTrackIds\\":" & my jsonStringArray(missingTrackIds) & ",\\"failedTrackIds\\":" & my jsonStringArray(failedTrackIds) & "}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try`;

  const result = await run(buildScript(body), 60_000);

  const parsed = parseAppleScriptJsonOutput(
    result.stdout,
    removeTracksResultSchema,
    "Music returned an invalid remove tracks payload.",
  );
  validateRemoveTracksResult(parsed, playlistId, trackIds);
  return parsed;
}

function parseAppleScriptJsonOutput<Schema extends z.ZodType>(
  stdout: string,
  schema: Schema,
  invalidPayloadMessage: string,
): z.output<Schema> {
  try {
    return schema.parse(JSON.parse(stdout));
  } catch {
    throw new MusicToolError("script_error", invalidPayloadMessage, {
      outputLength: stdout.length,
    });
  }
}

function validateTrackMutationClassifications(
  result: { playlistId: string; requested: number },
  playlistId: string,
  trackIds: string[],
  classifications: string[][],
  inconsistentResultMessage: string,
): { classifiedIds: Set<string>; classificationSets: Set<string>[] } {
  const requestedIds = toCanonicalTrackIdSet(trackIds);
  const classificationSets = classifications.map(toCanonicalTrackIdSet);
  const classifiedIds = new Set(classificationSets.flatMap((ids) => [...ids]));
  const containsUnknownId = [...classifiedIds].some((id) => !requestedIds.has(id));

  if (
    canonicalTrackId(result.playlistId) !== canonicalTrackId(playlistId) ||
    result.requested !== trackIds.length ||
    classifications.some(hasDuplicateTrackIds) ||
    containsUnknownId ||
    classifiedIds.size !== requestedIds.size
  ) {
    throw new MusicToolError("script_error", inconsistentResultMessage);
  }
  return { classifiedIds, classificationSets };
}

function validateRemoveTracksResult(
  result: RemoveTracksResult,
  playlistId: string,
  trackIds: string[],
): void {
  const { classificationSets } = validateTrackMutationClassifications(
    result,
    playlistId,
    trackIds,
    [result.removedTrackIds, result.missingTrackIds, result.failedTrackIds],
    "Music returned inconsistent remove track results.",
  );
  const removedIds = classificationSets[0]!;
  const missingIds = classificationSets[1]!;
  const failedIds = classificationSets[2]!;
  const missingOverlapsOutcome = [...missingIds].some(
    (id) => removedIds.has(id) || failedIds.has(id),
  );

  if (result.removed < result.removedTrackIds.length || missingOverlapsOutcome) {
    throw new MusicToolError("script_error", "Music returned inconsistent remove track results.");
  }
}

function assertUniqueTrackIds(trackIds: string[]): void {
  if (hasDuplicateTrackIds(trackIds)) {
    throw new MusicToolError("validation_error", "Track IDs must be unique.");
  }
}

export function createTrackOperations(run: typeof runAppleScript = runAppleScript) {
  return {
    findTracks: (criteria: TrackCriteria) => findTracksWithRunner(run, criteria),
    addTracksToPlaylist: (playlistId: string, trackIds: string[]) =>
      addTracksToPlaylistWithRunner(run, playlistId, trackIds),
    removeTracksFromPlaylist: (playlistId: string, trackIds: string[]) =>
      removeTracksFromPlaylistWithRunner(run, playlistId, trackIds),
  };
}

const defaultTrackOperations = createTrackOperations();
export const findTracks = defaultTrackOperations.findTracks;
export const addTracksToPlaylist = defaultTrackOperations.addTracksToPlaylist;

function createTrackComparator(
  sortBy: TrackSortBy,
): (left: LibraryTrack, right: LibraryTrack) => number {
  switch (sortBy) {
    case "artist":
      return (left, right) =>
        compareText(left.artist, right.artist) ||
        compareText(left.album, right.album) ||
        compareText(left.name, right.name);
    case "album":
      return (left, right) =>
        compareText(left.album, right.album) ||
        compareText(left.artist, right.artist) ||
        compareText(left.name, right.name);
    case "year":
      return (left, right) =>
        right.year - left.year ||
        compareText(left.artist, right.artist) ||
        compareText(left.name, right.name);
    case "playCount":
      return (left, right) =>
        right.playCount - left.playCount ||
        compareText(left.artist, right.artist) ||
        compareText(left.name, right.name);
    case "name":
    default:
      return (left, right) =>
        compareText(left.name, right.name) ||
        compareText(left.artist, right.artist) ||
        compareText(left.album, right.album);
  }
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

export function pickTrackSearchSeed(criteria: TrackCriteria): string | undefined {
  const candidates = [criteria.nameQuery, criteria.artist, criteria.album, criteria.genre]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);

  return candidates[0];
}

export function matchesTrackCriteria(track: LibraryTrack, criteria: TrackCriteria): boolean {
  if (!containsText(track.name, criteria.nameQuery)) return false;
  if (!containsText(track.artist, criteria.artist)) return false;
  if (!containsText(track.album, criteria.album)) return false;
  if (!containsText(track.genre, criteria.genre)) return false;
  if (criteria.yearMin !== undefined && track.year < criteria.yearMin) return false;
  if (criteria.yearMax !== undefined && track.year > criteria.yearMax) return false;
  if (criteria.playCountMin !== undefined && track.playCount < criteria.playCountMin) return false;
  if (criteria.playCountMax !== undefined && track.playCount > criteria.playCountMax) return false;
  return true;
}

function containsText(value: string, needle: string | undefined): boolean {
  if (!needle) return true;
  return value.toLowerCase().includes(needle.toLowerCase());
}
