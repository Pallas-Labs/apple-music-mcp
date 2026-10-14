import * as z from "zod/v4";

import { escapeAppleScriptString } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runAppleScript, type ExecFn } from "../applescript/runner.js";
import { buildScript } from "../applescript/templates.js";
import { nameSchema, persistentIdSchema } from "../config.js";
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  defineTool,
  READ_ONLY_ANNOTATIONS,
} from "../tool-contracts.js";
import { readParentIds, readPlaylistEntries } from "./playlist-tree.js";

const folderSchema = z.object({
  id: z.string().describe("Persistent folder ID."),
  name: z.string(),
  isRoot: z
    .boolean()
    .describe("True when the folder is at the top level of the library."),
  parentId: z
    .string()
    .optional()
    .describe(
      "Persistent ID of the parent folder. Omitted for top-level folders."
    ),
});
type Folder = z.output<typeof folderSchema>;
const folderRowSchema = folderSchema
  .pick({ id: true, name: true })
  .extend({ parentId: z.string() });
const listFoldersInputSchema = z.object({
  includeEmpty: z
    .boolean()
    .optional()
    .describe(
      "Include folders that directly contain no playlists (default true)."
    ),
});
const listFoldersOutputSchema = z.object({
  folders: z.array(folderSchema),
});
const createFolderInputSchema = z.object({
  name: nameSchema.describe("Folder name, 1-255 characters."),
  parentId: persistentIdSchema
    .optional()
    .describe(
      "Persistent folder ID from music.list_folders or music.create_folder. Omit to create at the top level."
    ),
});
const createFolderOutputSchema = z.object({
  folder: folderSchema,
});

export const listFoldersTool = defineTool({
  name: "music.list_folders",
  description:
    "List Apple Music folder playlists with their persistent IDs and parent folder IDs.",
  inputSchema: listFoldersInputSchema,
  outputSchema: listFoldersOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  writesRequired: false,
  async handler({ includeEmpty = true }) {
    const folders = await folderOperations.listFolders(includeEmpty);
    return {
      structuredContent: { folders },
      logData: { folderCount: folders.length, includeEmpty },
    };
  },
});

export const createFolderTool = defineTool({
  name: "music.create_folder",
  description:
    "Create a folder playlist, optionally inside a parent folder. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  inputSchema: createFolderInputSchema,
  outputSchema: createFolderOutputSchema,
  annotations: ADDITIVE_WRITE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult({ name, parentId }) {
    return {
      folder: {
        id: `DRYRUN_${Date.now()}`,
        name,
        isRoot: parentId === undefined,
        ...(parentId !== undefined ? { parentId } : {}),
      },
    };
  },
  async handler({ name, parentId }) {
    const input: { name: string; parentId?: string } = { name };
    if (parentId !== undefined) input.parentId = parentId;
    const folder = await folderOperations.createFolder(input);
    return { structuredContent: { folder }, logData: { folderId: folder.id } };
  },
});

async function listFolders(
  includeEmpty: boolean,
  execFn: ExecFn | undefined
): Promise<Folder[]> {
  const entries = await readPlaylistEntries(execFn);
  const folders = entries.filter((entry) => entry.kind === "folder");
  // A folder counts as empty when no user playlist sits directly inside it.
  const parentIds = await readParentIds(
    (includeEmpty ? folders : entries).map((entry) => entry.id),
    execFn
  );
  const nonEmptyIds = new Set(
    entries.flatMap((entry) =>
      entry.kind === "user" ? [parentIds.get(entry.id)] : []
    )
  );
  return folders
    .filter((folder) => includeEmpty || nonEmptyIds.has(folder.id))
    .map((folder) =>
      toFolder({ ...folder, parentId: parentIds.get(folder.id) ?? "" })
    );
}

async function createFolder(
  input: { name: string; parentId?: string },
  execFn: ExecFn | undefined
): Promise<Folder> {
  const safeName = escapeAppleScriptString(input.name);
  const safeParentId = escapeAppleScriptString(input.parentId ?? "");
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 30 seconds
            set newFolder to make new folder playlist with properties {name: "${safeName}"}

            if "${safeParentId}" is not "" then
                set targetParent to first folder playlist whose persistent ID is "${safeParentId}"
                move newFolder to targetParent
            end if

            set parentFolderId to ""
            try
                set parentFolderId to persistent ID of (parent of newFolder) as text
            on error
                set parentFolderId to ""
            end try

            return my jsonFolder((persistent ID of newFolder as text), (name of newFolder as text), parentFolderId)
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonFolder(folderId, folderName, parentFolderId)
    return "{\\"id\\":\\"" & my jsonEscape(folderId) & "\\",\\"name\\":\\"" & my jsonEscape(folderName) & "\\",\\"parentId\\":\\"" & my jsonEscape(parentFolderId) & "\\"}"
end jsonFolder`;

  const result = await runAppleScript(buildScript(body), 40_000, execFn);
  return toFolder(
    parseAppleScriptJson(
      result.stdout,
      folderRowSchema,
      "Music returned an invalid create folder payload."
    )
  );
}

function toFolder(row: z.output<typeof folderRowSchema>): Folder {
  const parentId = row.parentId.trim();
  return {
    id: row.id,
    name: row.name,
    isRoot: parentId.length === 0,
    ...(parentId.length > 0 ? { parentId } : {}),
  };
}

export function createFolderOperations(execFn?: ExecFn) {
  return {
    listFolders: (includeEmpty: boolean) => listFolders(includeEmpty, execFn),
    createFolder: (input: { name: string; parentId?: string }) =>
      createFolder(input, execFn),
  };
}

const folderOperations = createFolderOperations();
