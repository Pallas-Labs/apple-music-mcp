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

  constructor(code: MusicToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MusicToolError";
    this.code = code;
    this.details = details;
  }
}

export type MusicHealth = {
  musicRunning: boolean;
  permissionGranted: boolean;
  serverVersion: string;
};

export type Folder = {
  id: string;
  name: string;
  isRoot: boolean;
  parentId?: string;
};

export type Playlist = {
  id: string;
  name: string;
  folderId?: string;
  isSmart: boolean;
  trackCount?: number;
};

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

export type NowPlaying = {
  name: string;
  artist: string;
  album: string;
  duration: number;
  position: number;
  playerState: "playing" | "paused" | "stopped";
};
