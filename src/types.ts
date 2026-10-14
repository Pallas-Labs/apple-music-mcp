export type MusicToolErrorCode =
  | "permission_denied"
  | "music_not_running"
  | "not_found"
  | "validation_error"
  | "timeout"
  | "script_error";

export class MusicToolError extends Error {
  readonly code: MusicToolErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: MusicToolErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "MusicToolError";
    this.code = code;
    this.details = details;
  }
}

export type Track = {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
};

export type LibraryTrack = Track & {
  genre: string;
  year: number;
  playCount: number;
};

export type TrackSortBy = "name" | "artist" | "album" | "year" | "playCount";

export type TrackCriteria = {
  nameQuery?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  genre?: string | undefined;
  yearMin?: number | undefined;
  yearMax?: number | undefined;
  playCountMin?: number | undefined;
  playCountMax?: number | undefined;
  limit?: number | undefined;
  sortBy?: TrackSortBy | undefined;
};
