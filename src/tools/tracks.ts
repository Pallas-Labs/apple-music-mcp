import * as z from "zod/v4";
import { persistentIdSchema } from "../config.js";
import { runAppleScript, runJavaScript } from "../applescript/runner.js";
import type { ExecFn } from "../applescript/runner.js";
import { escapeAppleScriptString, toJavaScriptLiteral } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { buildJavaScript, buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { LibraryTrack, Track, TrackCriteria, TrackSortBy } from "../types.js";
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  defineTool,
  DESTRUCTIVE_WRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  type ToolSchemaOutput,
} from "../tool-contracts.js";

/** Cap on candidate rows returned from Music, bounding payload size and server memory. */
export const FIND_TRACKS_CANDIDATE_CAP = 50_000;
const CANDIDATE_CAP_TEXT = FIND_TRACKS_CANDIDATE_CAP.toLocaleString("en-US");

export const scannedOutputSchema = z
  .number()
  .describe(
    `Number of candidate tracks Music returned for the primary filter and that were examined, at most ${CANDIDATE_CAP_TEXT}.`,
  );
export const truncatedOutputSchema = z
  .boolean()
  .describe(
    `True when more than ${CANDIDATE_CAP_TEXT} candidates matched the primary filter, so matches may be missing.`,
  );

/** Track property paired with the criteria field that substring-matches it. */
const TEXT_FILTERS = [
  ["name", "nameQuery"],
  ["artist", "artist"],
  ["album", "album"],
  ["genre", "genre"],
] as const;

const textCollator = new Intl.Collator("en", { sensitivity: "base" });

/**
 * JXA that binds `playlist` from a `playlistId` constant. Music re-evaluates a whose-based
 * specifier on every command that names it (350 ms per duplicate against 500 playlists), so
 * commands address the playlist by database ID instead. Reading `.id()` on an empty whose
 * result throws -1728, which the runner maps to not_found.
 */
const PIN_USER_PLAYLIST = `const playlist = music.userPlaylists.byId(music.userPlaylists.whose({persistentID: playlistId})[0].id());`;

function canonicalTrackId(trackId: string): string {
  return trackId.toUpperCase();
}

function toCanonicalTrackIdSet(trackIds: string[]): Set<string> {
  return new Set(trackIds.map(canonicalTrackId));
}

function hasDuplicateTrackIds(trackIds: string[]): boolean {
  return toCanonicalTrackIdSet(trackIds).size !== trackIds.length;
}

export const trackIdOutputSchema = z
  .string()
  .describe(
    "Persistent track ID for music.add_tracks_to_playlist and music.remove_tracks_from_playlist.",
  );
export const durationOutputSchema = z.number().describe("Track length in seconds.");

const libraryTrackSchema = z.object({
  id: trackIdOutputSchema,
  name: z.string(),
  artist: z.string(),
  album: z.string(),
  genre: z.string(),
  duration: durationOutputSchema,
  year: z.number().describe("Release year. 0 when unknown."),
  playCount: z.number().describe("Number of times the track was played."),
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
  yearMin: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .optional()
    .describe("Earliest release year, inclusive. Tracks with no year have year 0."),
  yearMax: z.number().int().min(0).max(9999).optional().describe("Latest release year, inclusive."),
  playCountMin: z.number().int().min(0).optional().describe("Minimum play count, inclusive."),
  playCountMax: z.number().int().min(0).optional().describe("Maximum play count, inclusive."),
  sortBy: z
    .enum(["name", "artist", "album", "year", "playCount"])
    .optional()
    .describe(
      "Sort order (default name). name, artist, and album sort A to Z; year and playCount sort highest first.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum tracks to return, 1-200 (default 50)."),
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

const findTracksOutputSchema = z.object({
  tracks: z.array(libraryTrackSchema).describe("Matching tracks after sorting, at most limit."),
  totalMatched: z
    .number()
    .describe(
      "Number of scanned tracks that matched every filter. When truncated is true, this is a lower bound, not a full-library total.",
    ),
  limit: z.number().describe("The limit that was applied."),
  scanned: scannedOutputSchema,
  truncated: truncatedOutputSchema,
});
const getPlaylistTracksInputSchema = z.object({
  playlistId: persistentIdSchema.describe(
    "Persistent playlist ID from music.list_playlists or music.create_playlist.",
  ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based index of the first track to return (default 0)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum tracks to return, 1-100 (default 50)."),
});
const getPlaylistTracksOutputSchema = z.object({
  tracks: z.array(
    z.object({
      id: trackIdOutputSchema,
      name: z.string(),
      artist: z.string(),
      album: z.string(),
      duration: durationOutputSchema,
    }),
  ),
  total: z.number().describe("Number of tracks in the whole playlist."),
  offset: z.number().describe("The offset that was applied."),
  limit: z.number().describe("The limit that was applied."),
});
export const trackIdsSchema = z
  .array(persistentIdSchema)
  .min(1)
  .max(100)
  .refine((trackIds) => !hasDuplicateTrackIds(trackIds), {
    message: "Track IDs must be unique.",
  })
  .describe(
    "1-100 unique persistent track IDs from music.find_tracks, music.search_library, or music.get_playlist_tracks.",
  );
const trackMutationInputSchema = z.object({
  playlistId: persistentIdSchema.describe(
    "Persistent playlist ID from music.list_playlists or music.create_playlist.",
  ),
  trackIds: trackIdsSchema,
});
const requestedOutputSchema = z
  .number()
  .int()
  .min(0)
  .describe("Number of track IDs in the request.");
const addTracksOutputSchema = z.object({
  playlistId: z.string(),
  requested: requestedOutputSchema,
  added: z.number().int().min(0).describe("Number of tracks added. Equals addedTrackIds.length."),
  addedTrackIds: z.array(z.string()).describe("Requested IDs that were added to the playlist."),
  missingTrackIds: z
    .array(z.string())
    .describe("Requested IDs that were not found in the library."),
  failedTrackIds: z
    .array(z.string())
    .describe("Requested IDs that were found in the library but could not be added."),
});
const removeTracksOutputSchema = z.object({
  playlistId: z.string(),
  requested: requestedOutputSchema,
  removed: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of playlist entries deleted. Can exceed removedTrackIds.length when a track appears more than once.",
    ),
  removedTrackIds: z
    .array(z.string())
    .describe("Requested IDs with at least one playlist instance removed."),
  missingTrackIds: z.array(z.string()).describe("Requested IDs with no instance in the playlist."),
  failedTrackIds: z
    .array(z.string())
    .describe(
      "Requested IDs with at least one instance that could not be removed. Can overlap removedTrackIds.",
    ),
});
const addTracksResultSchema = addTracksOutputSchema;
const removeTracksResultSchema = removeTracksOutputSchema;
const findTracksScriptResultSchema = z.object({
  tracks: z.array(libraryTrackSchema),
  scanned: z.number().int().min(0),
  truncated: z.boolean(),
});
const playlistTracksResultSchema = getPlaylistTracksOutputSchema;

export type FindTracksResult = ToolSchemaOutput<typeof findTracksOutputSchema>;
export type AddTracksResult = ToolSchemaOutput<typeof addTracksOutputSchema>;
export type RemoveTracksResult = ToolSchemaOutput<typeof removeTracksOutputSchema>;

export const findTracksTool = defineTool({
  name: "music.find_tracks",
  description: `Find library tracks by name, artist, album, genre, year, or play count across the whole library.\nRequires at least one filter. Up to ${CANDIDATE_CAP_TEXT} candidates are examined; when truncated is true, totalMatched is a lower bound.`,
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
  description: "Get one page of a playlist's tracks with persistent IDs, using offset and limit.",
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
  description:
    "Add up to 100 unique tracks to a playlist by persistent ID and report per-ID outcomes.\nRequires APPLE_MUSIC_MCP_ENABLE_WRITES=true. Not atomic: check missingTrackIds and failedTrackIds.",
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
  description:
    "Remove every instance of up to 100 unique tracks from a playlist and report per-ID outcomes.\nRequires APPLE_MUSIC_MCP_ENABLE_WRITES=true. Not atomic: check missingTrackIds and failedTrackIds.",
  inputSchema: trackMutationInputSchema,
  outputSchema: removeTracksOutputSchema,
  annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
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
  execFn: ExecFn | undefined,
  criteria: TrackCriteria,
): Promise<FindTracksResult> {
  const validatedCriteria = trackCriteriaSchema.parse(criteria);
  const prefilter = pickFindTracksPrefilter(validatedCriteria);
  const whoseLiteral = prefilter
    ? toJavaScriptLiteral({ [prefilter.property]: { [prefilter.operator]: prefilter.value } })
    : "null";

  // Music accepts only one comparison per whose clause from JXA; the rest is filtered in TS.
  // Property reads on an empty whose result throw, so the count check guards them.
  const body = `
const whose = ${whoseLiteral};
const library = music.libraryPlaylists[0];
const candidates = whose ? library.tracks.whose(whose) : library.tracks;
let candidateCount = candidates.length;
const tracks = [];
if (candidateCount > 0) {
    const ids = candidates.persistentID();
    const names = candidates.name();
    const artists = candidates.artist();
    const albums = candidates.album();
    const genres = candidates.genre();
    const durations = candidates.duration();
    const years = candidates.year();
    const playCounts = candidates.playedCount();
    const columns = [names, artists, albums, genres, durations, years, playCounts];
    if (columns.some((column) => column.length !== ids.length)) {
        throw new Error("Music library changed while reading tracks.");
    }
    candidateCount = ids.length;
    for (let i = 0; i < Math.min(candidateCount, ${FIND_TRACKS_CANDIDATE_CAP}); i += 1) {
        tracks.push({
            id: ids[i],
            name: names[i],
            artist: artists[i],
            album: albums[i],
            genre: genres[i],
            duration: durations[i],
            year: years[i],
            playCount: playCounts[i],
        });
    }
}
JSON.stringify({ tracks, scanned: tracks.length, truncated: candidateCount > tracks.length });`;

  const result = await runJavaScript(buildJavaScript(body), 120_000, execFn);

  const parsed = parseAppleScriptJson(
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

  const parsed = parseAppleScriptJson(
    result.stdout,
    playlistTracksResultSchema,
    "Music returned an invalid playlist tracks payload.",
  );
  return parsed;
}

async function addTracksToPlaylistWithRunner(
  execFn: ExecFn | undefined,
  playlistId: string,
  trackIds: string[],
): Promise<AddTracksResult> {
  assertUniqueTrackIds(trackIds);
  // One bulk read of the library's IDs replaces a library-wide whose lookup per requested ID.
  // Music rejects duplicating a list of tracks (-10006), so tracks are still duplicated one at a time.
  const body = `
const requestedIds = ${toJavaScriptLiteral(trackIds)};
const playlistId = ${toJavaScriptLiteral(playlistId)};
${PIN_USER_PLAYLIST}
const library = music.libraryPlaylists[0];
const libraryIds = library.tracks.length > 0 ? library.tracks.persistentID() : [];
const databaseIds = library.tracks.length > 0 ? library.tracks.id() : [];
if (libraryIds.length !== databaseIds.length) {
    throw new Error("Music library changed while reading tracks.");
}
const databaseIdByTrackId = new Map();
libraryIds.forEach((id, index) => databaseIdByTrackId.set(id.toUpperCase(), databaseIds[index]));
const addedTrackIds = [];
const missingTrackIds = [];
const failedTrackIds = [];
for (const trackId of requestedIds) {
    const databaseId = databaseIdByTrackId.get(trackId.toUpperCase());
    if (databaseId === undefined) {
        missingTrackIds.push(trackId);
        continue;
    }
    try {
        music.duplicate(library.tracks.byId(databaseId), {to: playlist});
        addedTrackIds.push(trackId);
    } catch (error) {
        failedTrackIds.push(trackId);
    }
}
JSON.stringify({
    playlistId,
    requested: requestedIds.length,
    added: addedTrackIds.length,
    addedTrackIds,
    missingTrackIds,
    failedTrackIds,
});`;

  const result = await runJavaScript(buildJavaScript(body), 60_000, execFn);

  const parsed = parseAppleScriptJson(
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
  execFn: ExecFn | undefined,
  playlistId: string,
  trackIds: string[],
): Promise<RemoveTracksResult> {
  assertUniqueTrackIds(trackIds);
  // Every playlist entry has its own database ID, so deleting by that ID stays correct even if
  // the playlist shifts under the script; the reverse walk only keeps the pairing with entryIds.
  const body = `
const requestedIds = ${toJavaScriptLiteral(trackIds)};
const playlistId = ${toJavaScriptLiteral(playlistId)};
${PIN_USER_PLAYLIST}
const entryIds = playlist.tracks.length > 0 ? playlist.tracks.persistentID() : [];
const databaseIds = playlist.tracks.length > 0 ? playlist.tracks.id() : [];
if (entryIds.length !== databaseIds.length) {
    throw new Error("Music playlist changed while reading tracks.");
}
const requestedByCanonicalId = new Map(requestedIds.map((id) => [id.toUpperCase(), id]));
let removed = 0;
const removedTrackIds = new Set();
const failedTrackIds = new Set();
for (let index = entryIds.length - 1; index >= 0; index -= 1) {
    const trackId = requestedByCanonicalId.get(entryIds[index].toUpperCase());
    if (trackId === undefined) continue;
    try {
        music.delete(playlist.tracks.byId(databaseIds[index]));
        removed += 1;
        removedTrackIds.add(trackId);
    } catch (error) {
        failedTrackIds.add(trackId);
    }
}
const missingTrackIds = requestedIds.filter(
    (id) => !removedTrackIds.has(id) && !failedTrackIds.has(id),
);
JSON.stringify({
    playlistId,
    requested: requestedIds.length,
    removed,
    removedTrackIds: [...removedTrackIds],
    missingTrackIds,
    failedTrackIds: [...failedTrackIds],
});`;

  const result = await runJavaScript(buildJavaScript(body), 60_000, execFn);

  const parsed = parseAppleScriptJson(
    result.stdout,
    removeTracksResultSchema,
    "Music returned an invalid remove tracks payload.",
  );
  validateRemoveTracksResult(parsed, playlistId, trackIds);
  return parsed;
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

export function createTrackOperations(execFn?: ExecFn) {
  return {
    findTracks: (criteria: TrackCriteria) => findTracksWithRunner(execFn, criteria),
    addTracksToPlaylist: (playlistId: string, trackIds: string[]) =>
      addTracksToPlaylistWithRunner(execFn, playlistId, trackIds),
    removeTracksFromPlaylist: (playlistId: string, trackIds: string[]) =>
      removeTracksFromPlaylistWithRunner(execFn, playlistId, trackIds),
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
  return textCollator.compare(left, right);
}

export type FindTracksPrefilter =
  | { property: "name" | "artist" | "album" | "genre"; operator: "_contains"; value: string }
  | {
      property: "year" | "playedCount";
      operator: "_greaterThanEquals" | "_lessThanEquals";
      value: number;
    };

/**
 * Choose the one comparison Music evaluates itself. The longest text filter wins because
 * substring matches prune far more than year or play-count bounds. Numeric bounds fall back
 * in the order that pruned most on a real library: play-count floor, year ceiling, year
 * floor, play-count ceiling.
 */
export function pickFindTracksPrefilter(criteria: TrackCriteria): FindTracksPrefilter | undefined {
  let longest: { property: (typeof TEXT_FILTERS)[number][0]; value: string } | undefined;
  for (const [property, field] of TEXT_FILTERS) {
    const value = criteria[field];
    if (value && (!longest || value.length > longest.value.length)) {
      longest = { property, value };
    }
  }
  if (longest) return { ...longest, operator: "_contains" };

  if (criteria.playCountMin !== undefined) {
    return {
      property: "playedCount",
      operator: "_greaterThanEquals",
      value: criteria.playCountMin,
    };
  }
  if (criteria.yearMax !== undefined) {
    return { property: "year", operator: "_lessThanEquals", value: criteria.yearMax };
  }
  if (criteria.yearMin !== undefined) {
    return { property: "year", operator: "_greaterThanEquals", value: criteria.yearMin };
  }
  if (criteria.playCountMax !== undefined) {
    return { property: "playedCount", operator: "_lessThanEquals", value: criteria.playCountMax };
  }
  return undefined;
}

export function matchesTrackCriteria(track: LibraryTrack, criteria: TrackCriteria): boolean {
  for (const [property, field] of TEXT_FILTERS) {
    if (!containsText(track[property], criteria[field])) return false;
  }
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
