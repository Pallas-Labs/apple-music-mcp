import * as z from "zod/v4";

import { toJavaScriptLiteral } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runJavaScript } from "../applescript/runner.js";
import type { ExecFn } from "../applescript/runner.js";
import { buildJavaScript } from "../applescript/templates.js";
import { persistentIdSchema } from "../config.js";
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  defineTool,
  DESTRUCTIVE_WRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
} from "../tool-contracts.js";
import type { ToolSchemaOutput } from "../tool-contracts.js";
import { MusicToolError } from "../types.js";
import type {
  LibraryTrack,
  Track,
  TrackCriteria,
  TrackSortBy,
} from "../types.js";

/** Cap on candidate rows returned from Music, bounding payload size and server memory. */
export const FIND_TRACKS_CANDIDATE_CAP = 50_000;
const CANDIDATE_CAP_TEXT = FIND_TRACKS_CANDIDATE_CAP.toLocaleString("en-US");

export const scannedOutputSchema = z
  .number()
  .describe(
    `Number of candidate tracks Music returned for the primary filter and that were examined, at most ${CANDIDATE_CAP_TEXT}.`
  );
export const truncatedOutputSchema = z
  .boolean()
  .describe(
    `True when more than ${CANDIDATE_CAP_TEXT} candidates matched the primary filter, so matches may be missing.`
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
    "Persistent track ID for music.add_tracks_to_playlist and music.remove_tracks_from_playlist."
  );
export const durationOutputSchema = z
  .number()
  .describe("Track length in seconds.");

const libraryTrackSchema = z.object({
  album: z.string(),
  artist: z.string(),
  duration: durationOutputSchema,
  genre: z.string(),
  id: trackIdOutputSchema,
  name: z.string(),
  playCount: z.number().describe("Number of times the track was played."),
  year: z.number().describe("Release year. 0 when unknown."),
});

export const trackCriteriaShape = {
  album: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Case-insensitive substring match against album."),
  artist: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Case-insensitive substring match against artist."),
  genre: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Case-insensitive substring match against genre."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum tracks to return, 1-200 (default 50)."),
  nameQuery: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Case-insensitive substring match against track name."),
  playCountMax: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Maximum play count, inclusive."),
  playCountMin: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minimum play count, inclusive."),
  sortBy: z
    .enum(["name", "artist", "album", "year", "playCount"])
    .optional()
    .describe(
      "Sort order (default name). name, artist, and album sort A to Z; year and playCount sort highest first."
    ),
  yearMax: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .optional()
    .describe("Latest release year, inclusive."),
  yearMin: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .optional()
    .describe(
      "Earliest release year, inclusive. Tracks with no year have year 0."
    ),
} satisfies z.ZodRawShape;

export const trackCriteriaSchema = z
  .object(trackCriteriaShape)
  .superRefine((criteria, context) => {
    const hasTextFilter = [
      criteria.nameQuery,
      criteria.artist,
      criteria.album,
      criteria.genre,
    ].some((value) => value !== undefined && value.trim().length > 0);
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
  limit: z.number().describe("The limit that was applied."),
  scanned: scannedOutputSchema,
  totalMatched: z
    .number()
    .describe(
      "Number of scanned tracks that matched every filter. When truncated is true, this is a lower bound, not a full-library total."
    ),
  tracks: z
    .array(libraryTrackSchema)
    .describe("Matching tracks after sorting, at most limit."),
  truncated: truncatedOutputSchema,
});
const getPlaylistTracksInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum tracks to return, 1-100 (default 50)."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based index of the first track to return (default 0)."),
  playlistId: persistentIdSchema.describe(
    "Persistent playlist ID from music.list_playlists or music.create_playlist."
  ),
});
const getPlaylistTracksOutputSchema = z.object({
  limit: z.number().describe("The limit that was applied."),
  offset: z.number().describe("The offset that was applied."),
  total: z.number().describe("Number of tracks in the whole playlist."),
  tracks: z.array(
    z.object({
      id: trackIdOutputSchema,
      name: z.string(),
      artist: z.string(),
      album: z.string(),
      duration: durationOutputSchema,
    })
  ),
});
export const trackIdsSchema = z
  .array(persistentIdSchema)
  .min(1)
  .max(100)
  .refine((trackIds) => !hasDuplicateTrackIds(trackIds), {
    message: "Track IDs must be unique.",
  })
  .describe(
    "1-100 unique persistent track IDs from music.find_tracks, music.search_library, or music.get_playlist_tracks."
  );
const trackMutationInputSchema = z.object({
  playlistId: persistentIdSchema.describe(
    "Persistent playlist ID from music.list_playlists or music.create_playlist."
  ),
  trackIds: trackIdsSchema,
});
const requestedOutputSchema = z
  .number()
  .int()
  .min(0)
  .describe("Number of track IDs in the request.");
const addTracksOutputSchema = z.object({
  added: z
    .number()
    .int()
    .min(0)
    .describe("Number of tracks added. Equals addedTrackIds.length."),
  addedTrackIds: z
    .array(z.string())
    .describe("Requested IDs that were added to the playlist."),
  failedTrackIds: z
    .array(z.string())
    .describe(
      "Requested IDs that were found in the library but could not be added."
    ),
  missingTrackIds: z
    .array(z.string())
    .describe("Requested IDs that were not found in the library."),
  playlistId: z.string(),
  requested: requestedOutputSchema,
});
const removeTracksOutputSchema = z.object({
  failedTrackIds: z
    .array(z.string())
    .describe(
      "Requested IDs with at least one instance that could not be removed. Can overlap removedTrackIds."
    ),
  missingTrackIds: z
    .array(z.string())
    .describe("Requested IDs with no instance in the playlist."),
  playlistId: z.string(),
  removed: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of playlist entries deleted. Can exceed removedTrackIds.length when a track appears more than once."
    ),
  removedTrackIds: z
    .array(z.string())
    .describe("Requested IDs with at least one playlist instance removed."),
  requested: requestedOutputSchema,
});
const addTracksResultSchema = addTracksOutputSchema;
const removeTracksResultSchema = removeTracksOutputSchema;
const findTracksPageSchema = z.array(libraryTrackSchema);

/** Column name in the find_tracks payload and its element type. */
const TRACK_COLUMNS = [
  ["ids", "string"],
  ["names", "string"],
  ["artists", "string"],
  ["albums", "string"],
  ["genres", "string"],
  ["durations", "number"],
  ["years", "number"],
  ["playCounts", "number"],
] as const;
type TrackColumns = Record<(typeof TRACK_COLUMNS)[number][0], unknown[]>;
const playlistTracksResultSchema = getPlaylistTracksOutputSchema;

export type FindTracksResult = ToolSchemaOutput<typeof findTracksOutputSchema>;
export type AddTracksResult = ToolSchemaOutput<typeof addTracksOutputSchema>;
export type RemoveTracksResult = ToolSchemaOutput<
  typeof removeTracksOutputSchema
>;

export const findTracksTool = defineTool({
  annotations: READ_ONLY_ANNOTATIONS,
  description: `Find library tracks by name, artist, album, genre, year, or play count across the whole library.\nRequires at least one filter. Up to ${CANDIDATE_CAP_TEXT} candidates are examined; when truncated is true, totalMatched is a lower bound.`,
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
  inputSchema: trackCriteriaSchema,
  name: "music.find_tracks",
  outputSchema: findTracksOutputSchema,
  writesRequired: false,
});

export const getPlaylistTracksTool = defineTool({
  annotations: READ_ONLY_ANNOTATIONS,
  description:
    "Get one page of a playlist's tracks with persistent IDs, using offset and limit.",
  async handler({ playlistId, offset, limit }) {
    const result = await defaultTrackOperations.getPlaylistTracks(
      playlistId,
      offset ?? 0,
      limit ?? 50
    );
    return {
      structuredContent: result,
      logData: {
        playlistId,
        trackCount: result.tracks.length,
        total: result.total,
      },
    };
  },
  inputSchema: getPlaylistTracksInputSchema,
  name: "music.get_playlist_tracks",
  outputSchema: getPlaylistTracksOutputSchema,
  writesRequired: false,
});

export const addTracksToPlaylistTool = defineTool({
  annotations: ADDITIVE_WRITE_ANNOTATIONS,
  description:
    "Add up to 100 unique tracks to a playlist by persistent ID and report per-ID outcomes.\nRequires APPLE_MUSIC_MCP_ENABLE_WRITES=true. Not atomic: check missingTrackIds and failedTrackIds.",
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
  inputSchema: trackMutationInputSchema,
  name: "music.add_tracks_to_playlist",
  outputSchema: addTracksOutputSchema,
  writesRequired: true,
});

export const removeTracksFromPlaylistTool = defineTool({
  annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  description:
    "Remove every instance of up to 100 unique tracks from a playlist and report per-ID outcomes.\nRequires APPLE_MUSIC_MCP_ENABLE_WRITES=true. Not atomic: check missingTrackIds and failedTrackIds.",
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
    const result = await defaultTrackOperations.removeTracksFromPlaylist(
      playlistId,
      trackIds
    );
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
  inputSchema: trackMutationInputSchema,
  name: "music.remove_tracks_from_playlist",
  outputSchema: removeTracksOutputSchema,
  writesRequired: true,
});

async function findTracksWithRunner(
  execFn: ExecFn | undefined,
  criteria: TrackCriteria
): Promise<FindTracksResult> {
  const validatedCriteria = trackCriteriaSchema.parse(criteria);
  const prefilter = pickFindTracksPrefilter(validatedCriteria);
  const whoseLiteral = prefilter
    ? toJavaScriptLiteral({
        [prefilter.property]: { [prefilter.operator]: prefilter.value },
      })
    : "null";

  // Music accepts only one comparison per whose clause from JXA; the rest is filtered in TS.
  // Property reads on an empty whose result throw, so the count check guards them.
  const body = `
const whose = ${whoseLiteral};
const library = music.libraryPlaylists[0];
const candidates = whose ? library.tracks.whose(whose) : library.tracks;
let candidateCount = candidates.length;
let columns = { ids: [], names: [], artists: [], albums: [], genres: [], durations: [], years: [], playCounts: [] };
if (candidateCount > 0) {
    columns = {
        ids: candidates.persistentID(),
        names: candidates.name(),
        artists: candidates.artist(),
        albums: candidates.album(),
        genres: candidates.genre(),
        durations: candidates.duration(),
        years: candidates.year(),
        playCounts: candidates.playedCount(),
    };
    candidateCount = columns.ids.length;
    for (const name of Object.keys(columns)) {
        if (columns[name].length !== candidateCount) {
            throw new Error("Music library changed while reading tracks.");
        }
        columns[name] = columns[name].slice(0, ${FIND_TRACKS_CANDIDATE_CAP});
    }
}
JSON.stringify({ columns, scanned: columns.ids.length, truncated: candidateCount > columns.ids.length });`;

  const result = await runJavaScript(buildJavaScript(body), 120_000, execFn);

  const parsed = parseFindTracksPayload(result.stdout);
  const sortBy = validatedCriteria.sortBy ?? "name";
  const limit = validatedCriteria.limit ?? 50;
  const matches = createTrackMatcher(validatedCriteria);
  const matched: LibraryTrack[] = [];
  for (let index = 0; index < parsed.scanned; index += 1) {
    const track = trackAt(parsed.columns, index);
    if (matches(track)) {
      matched.push(track);
    }
  }
  matched.sort(createTrackComparator(sortBy));

  return {
    limit,
    scanned: parsed.scanned,
    totalMatched: matched.length,
    tracks: findTracksPageSchema.parse(matched.slice(0, limit)),
    truncated: parsed.truncated,
  };
}

const INVALID_FIND_TRACKS_PAYLOAD =
  "Music returned an invalid find tracks payload.";

/**
 * Validate the column payload in one pass over its primitives. Up to 50,000 candidates arrive
 * per call, so rows are not built or zod-validated until after filtering and the limit cut.
 */
function parseFindTracksPayload(stdout: string): {
  columns: TrackColumns;
  scanned: number;
  truncated: boolean;
} {
  const invalid = () =>
    new MusicToolError("script_error", INVALID_FIND_TRACKS_PAYLOAD, {
      outputLength: stdout.length,
    });
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw invalid();
  }
  if (typeof payload !== "object" || payload === null) {
    throw invalid();
  }
  const { columns, scanned, truncated } = payload as Record<string, unknown>;
  if (
    typeof columns !== "object" ||
    columns === null ||
    typeof truncated !== "boolean"
  ) {
    throw invalid();
  }
  if (!Number.isInteger(scanned) || (scanned as number) < 0) {
    throw invalid();
  }
  for (const [name, elementType] of TRACK_COLUMNS) {
    const column = (columns as Record<string, unknown>)[name];
    if (!Array.isArray(column) || column.length !== scanned) {
      throw invalid();
    }
    for (const value of column) {
      if (typeof value !== elementType) {
        throw invalid();
      }
    }
  }
  return {
    columns: columns as TrackColumns,
    scanned: scanned as number,
    truncated,
  };
}

function trackAt(columns: TrackColumns, index: number): LibraryTrack {
  return {
    album: columns.albums[index] as string,
    artist: columns.artists[index] as string,
    duration: columns.durations[index] as number,
    genre: columns.genres[index] as string,
    id: columns.ids[index] as string,
    name: columns.names[index] as string,
    playCount: columns.playCounts[index] as number,
    year: columns.years[index] as number,
  };
}

async function getPlaylistTracksWithRunner(
  execFn: ExecFn | undefined,
  playlistId: string,
  offset: number,
  limit: number
): Promise<{ tracks: Track[]; total: number; offset: number; limit: number }> {
  // JXA's slice(start, end) on a Music collection includes both ends, returns nothing when
  // start equals end, and throws when end passes the last entry. So the page is clamped first
  // and a one-entry page reads that entry by index.
  const body = `
const playlistId = ${toJavaScriptLiteral(playlistId)};
const offset = ${offset};
const limit = ${limit};
${PIN_USER_PLAYLIST}
const total = playlist.tracks.length;
const end = Math.min(offset + limit, total) - 1;
let ids = [];
let names = [];
let artists = [];
let albums = [];
let durations = [];
if (offset === end) {
    const entry = playlist.tracks[offset];
    ids = [entry.persistentID()];
    names = [entry.name()];
    artists = [entry.artist()];
    albums = [entry.album()];
    durations = [entry.duration()];
} else if (offset < end) {
    const page = playlist.tracks.slice(offset, end);
    ids = page.persistentID();
    names = page.name();
    artists = page.artist();
    albums = page.album();
    durations = page.duration();
}
if ([names, artists, albums, durations].some((column) => column.length !== ids.length)) {
    throw new Error("Music playlist changed while reading tracks.");
}
const tracks = ids.map((id, index) => ({
    id,
    name: names[index],
    artist: artists[index],
    album: albums[index],
    duration: durations[index],
}));
JSON.stringify({ tracks, total, offset, limit });`;

  const result = await runJavaScript(buildJavaScript(body), 60_000, execFn);

  return parseAppleScriptJson(
    result.stdout,
    playlistTracksResultSchema,
    "Music returned an invalid playlist tracks payload."
  );
}

async function addTracksToPlaylistWithRunner(
  execFn: ExecFn | undefined,
  playlistId: string,
  trackIds: string[]
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
    "Music returned an invalid add tracks payload."
  );
  const { classifiedIds, classificationSets } =
    validateTrackMutationClassifications(
      parsed,
      playlistId,
      trackIds,
      [parsed.addedTrackIds, parsed.missingTrackIds, parsed.failedTrackIds],
      "Music returned inconsistent add track results."
    );
  const classificationCount = classificationSets.reduce(
    (sum, ids) => sum + ids.size,
    0
  );
  if (
    parsed.added !== parsed.addedTrackIds.length ||
    classificationCount !== classifiedIds.size
  ) {
    throw new MusicToolError(
      "script_error",
      "Music returned inconsistent add track results."
    );
  }
  return parsed;
}

async function removeTracksFromPlaylistWithRunner(
  execFn: ExecFn | undefined,
  playlistId: string,
  trackIds: string[]
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
    "Music returned an invalid remove tracks payload."
  );
  validateRemoveTracksResult(parsed, playlistId, trackIds);
  return parsed;
}

function validateTrackMutationClassifications(
  result: { playlistId: string; requested: number },
  playlistId: string,
  trackIds: string[],
  classifications: string[][],
  inconsistentResultMessage: string
): { classifiedIds: Set<string>; classificationSets: Set<string>[] } {
  const requestedIds = toCanonicalTrackIdSet(trackIds);
  const classificationSets = classifications.map(toCanonicalTrackIdSet);
  const classifiedIds = new Set(classificationSets.flatMap((ids) => [...ids]));
  const containsUnknownId = [...classifiedIds].some(
    (id) => !requestedIds.has(id)
  );

  if (
    canonicalTrackId(result.playlistId) !== canonicalTrackId(playlistId) ||
    result.requested !== trackIds.length ||
    classifications.some(hasDuplicateTrackIds) ||
    containsUnknownId ||
    classifiedIds.size !== requestedIds.size
  ) {
    throw new MusicToolError("script_error", inconsistentResultMessage);
  }
  return { classificationSets, classifiedIds };
}

function validateRemoveTracksResult(
  result: RemoveTracksResult,
  playlistId: string,
  trackIds: string[]
): void {
  const { classificationSets } = validateTrackMutationClassifications(
    result,
    playlistId,
    trackIds,
    [result.removedTrackIds, result.missingTrackIds, result.failedTrackIds],
    "Music returned inconsistent remove track results."
  );
  const removedIds = classificationSets[0]!;
  const missingIds = classificationSets[1]!;
  const failedIds = classificationSets[2]!;
  const missingOverlapsOutcome = [...missingIds].some(
    (id) => removedIds.has(id) || failedIds.has(id)
  );

  if (
    result.removed < result.removedTrackIds.length ||
    missingOverlapsOutcome
  ) {
    throw new MusicToolError(
      "script_error",
      "Music returned inconsistent remove track results."
    );
  }
}

function assertUniqueTrackIds(trackIds: string[]): void {
  if (hasDuplicateTrackIds(trackIds)) {
    throw new MusicToolError("validation_error", "Track IDs must be unique.");
  }
}

export function createTrackOperations(execFn?: ExecFn) {
  return {
    addTracksToPlaylist: async (playlistId: string, trackIds: string[]) =>
      addTracksToPlaylistWithRunner(execFn, playlistId, trackIds),
    findTracks: async (criteria: TrackCriteria) =>
      findTracksWithRunner(execFn, criteria),
    getPlaylistTracks: async (
      playlistId: string,
      offset: number,
      limit: number
    ) => getPlaylistTracksWithRunner(execFn, playlistId, offset, limit),
    removeTracksFromPlaylist: async (playlistId: string, trackIds: string[]) =>
      removeTracksFromPlaylistWithRunner(execFn, playlistId, trackIds),
  };
}

const defaultTrackOperations = createTrackOperations();
export const { findTracks } = defaultTrackOperations;
export const { addTracksToPlaylist } = defaultTrackOperations;

function createTrackComparator(
  sortBy: TrackSortBy
): (left: LibraryTrack, right: LibraryTrack) => number {
  switch (sortBy) {
    case "artist": {
      return (left, right) =>
        compareText(left.artist, right.artist) ||
        compareText(left.album, right.album) ||
        compareText(left.name, right.name);
    }
    case "album": {
      return (left, right) =>
        compareText(left.album, right.album) ||
        compareText(left.artist, right.artist) ||
        compareText(left.name, right.name);
    }
    case "year": {
      return (left, right) =>
        right.year - left.year ||
        compareText(left.artist, right.artist) ||
        compareText(left.name, right.name);
    }
    case "playCount": {
      return (left, right) =>
        right.playCount - left.playCount ||
        compareText(left.artist, right.artist) ||
        compareText(left.name, right.name);
    }
    case "name":
    default: {
      return (left, right) =>
        compareText(left.name, right.name) ||
        compareText(left.artist, right.artist) ||
        compareText(left.album, right.album);
    }
  }
}

function compareText(left: string, right: string): number {
  return textCollator.compare(left, right);
}

export type FindTracksPrefilter =
  | {
      property: "name" | "artist" | "album" | "genre";
      operator: "_contains";
      value: string;
    }
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
export function pickFindTracksPrefilter(
  criteria: TrackCriteria
): FindTracksPrefilter | undefined {
  let longest:
    | { property: (typeof TEXT_FILTERS)[number][0]; value: string }
    | undefined;
  for (const [property, field] of TEXT_FILTERS) {
    const value = criteria[field];
    if (value && (!longest || value.length > longest.value.length)) {
      longest = { property, value };
    }
  }
  if (longest) {
    return { ...longest, operator: "_contains" };
  }

  if (criteria.playCountMin !== undefined) {
    return {
      operator: "_greaterThanEquals",
      property: "playedCount",
      value: criteria.playCountMin,
    };
  }
  if (criteria.yearMax !== undefined) {
    return {
      operator: "_lessThanEquals",
      property: "year",
      value: criteria.yearMax,
    };
  }
  if (criteria.yearMin !== undefined) {
    return {
      operator: "_greaterThanEquals",
      property: "year",
      value: criteria.yearMin,
    };
  }
  if (criteria.playCountMax !== undefined) {
    return {
      operator: "_lessThanEquals",
      property: "playedCount",
      value: criteria.playCountMax,
    };
  }
  return undefined;
}

export function matchesTrackCriteria(
  track: LibraryTrack,
  criteria: TrackCriteria
): boolean {
  return createTrackMatcher(criteria)(track);
}

/** Build the predicate once per call so the text needles are lowercased once, not per row. */
function createTrackMatcher(
  criteria: TrackCriteria
): (track: LibraryTrack) => boolean {
  const needles: [
    property: (typeof TEXT_FILTERS)[number][0],
    needle: string,
  ][] = [];
  for (const [property, field] of TEXT_FILTERS) {
    const needle = criteria[field];
    if (needle) {
      needles.push([property, needle.toLowerCase()]);
    }
  }
  const { yearMin, yearMax, playCountMin, playCountMax } = criteria;
  return (track) => {
    for (const [property, needle] of needles) {
      if (!track[property].toLowerCase().includes(needle)) {
        return false;
      }
    }
    if (yearMin !== undefined && track.year < yearMin) {
      return false;
    }
    if (yearMax !== undefined && track.year > yearMax) {
      return false;
    }
    if (playCountMin !== undefined && track.playCount < playCountMin) {
      return false;
    }
    if (playCountMax !== undefined && track.playCount > playCountMax) {
      return false;
    }
    return true;
  };
}
