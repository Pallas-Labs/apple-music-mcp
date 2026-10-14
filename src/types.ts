export type MusicToolErrorCode =
  | "permission_denied"
  | "music_not_running"
  | "not_found"
  | "validation_error"
  | "timeout"
  | "script_error";

/** JSON-safe diagnostic values. `undefined` members drop out when serialized. */
export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly DiagnosticValue[]
  | { readonly [key: string]: DiagnosticValue };

export type DiagnosticData = Readonly<Record<string, DiagnosticValue>>;

export class MusicToolError extends Error {
  readonly code: MusicToolErrorCode;
  readonly details: DiagnosticData | undefined;

  constructor(
    code: MusicToolErrorCode,
    message: string,
    details?: DiagnosticData
  ) {
    super(message);
    this.name = "MusicToolError";
    this.code = code;
    this.details = details;
  }
}

export interface Track {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
}

export type LibraryTrack = Track & {
  genre: string;
  year: number;
  playCount: number;
};

export type TrackSortBy = "name" | "artist" | "album" | "year" | "playCount";

export interface TrackCriteria {
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
}
