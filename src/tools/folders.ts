import * as z from "zod/v4";
import { nameSchema, persistentIdSchema } from "../config.js";
import { runAppleScript } from "../applescript/runner.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { Folder } from "../types.js";
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  defineTool,
  READ_ONLY_ANNOTATIONS,
} from "../tool-contracts.js";

const folderSchema = z.object({
  id: z.string(),
  name: z.string(),
  isRoot: z.boolean(),
  parentId: z.string().optional(),
});
const listFoldersInputSchema = z.object({
  includeEmpty: z.boolean().optional(),
});
const listFoldersOutputSchema = z.object({
  folders: z.array(folderSchema),
});
const createFolderInputSchema = z.object({
  name: nameSchema,
  parentId: persistentIdSchema.optional(),
});
const createFolderOutputSchema = z.object({
  folder: folderSchema,
});

export const listFoldersTool = defineTool({
  name: "music.list_folders",
  description: "List Apple Music folder playlists.",
  inputSchema: listFoldersInputSchema,
  outputSchema: listFoldersOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  writesRequired: false,
  async handler({ includeEmpty = true }) {
    const folders = await listFolders(includeEmpty);
    return {
      structuredContent: { folders },
      logData: { folderCount: folders.length, includeEmpty },
    };
  },
});

export const createFolderTool = defineTool({
  name: "music.create_folder",
  description: "Create a folder playlist, optionally inside a parent folder.",
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
    const folder = await createFolder(input);
    return { structuredContent: { folder }, logData: { folderId: folder.id } };
  },
});

async function listFolders(includeEmpty: boolean): Promise<Folder[]> {
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 30 seconds
            set folderRows to {}
            repeat with f in every folder playlist
                set folderId to persistent ID of f as text
                set folderName to name of f as text
                set parentFolderId to ""
                try
                    set parentFolderId to persistent ID of (parent of f) as text
                on error
                    set parentFolderId to ""
                end try
                set end of folderRows to {folderId, folderName, parentFolderId}
            end repeat
            return my jsonFolders(folderRows)
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonFolders(rows)
    set json to "["
    repeat with i from 1 to (count of rows)
        set row to item i of rows
        set fId to item 1 of row
        set fName to item 2 of row
        set pId to item 3 of row
        set json to json & "{\\"id\\":\\"" & my jsonEscape(fId as text) & "\\",\\"name\\":\\"" & my jsonEscape(fName as text) & "\\",\\"parentId\\":\\"" & my jsonEscape(pId as text) & "\\"}"
        if i < (count of rows) then
            set json to json & ","
        end if
    end repeat
    return json & "]"
end jsonFolders`;

  const result = await runAppleScript(buildScript(body), 40_000);

  let parsed: Array<{ id: string; name: string; parentId: string }>;
  try {
    parsed = JSON.parse(result.stdout) as Array<{ id: string; name: string; parentId: string }>;
  } catch {
    throw new MusicToolError("script_error", "Music returned an invalid folder payload.", {
      outputLength: result.stdout.length,
    });
  }

  const folders = parsed.map((f) => {
    const parentId = f.parentId.trim();
    const folder: Folder = {
      id: f.id,
      name: f.name,
      isRoot: parentId.length === 0,
    };
    if (parentId.length > 0) {
      folder.parentId = parentId;
    }
    return folder;
  });

  if (includeEmpty) {
    return folders;
  }

  const nonEmptyIds = await listNonEmptyFolderIds();
  return folders.filter((folder) => nonEmptyIds.has(folder.id));
}

async function listNonEmptyFolderIds(): Promise<Set<string>> {
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 30 seconds
            set folderIds to {}
            repeat with p in every user playlist
                try
                    set parentFolderId to persistent ID of (parent of p) as text
                    if parentFolderId is not "" then
                        set end of folderIds to parentFolderId
                    end if
                end try
            end repeat
            return my jsonIdList(folderIds)
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonIdList(rows)
    set json to "["
    repeat with i from 1 to (count of rows)
        set rowValue to item i of rows
        set json to json & "\\"" & my jsonEscape(rowValue as text) & "\\""
        if i < (count of rows) then
            set json to json & ","
        end if
    end repeat
    return json & "]"
end jsonIdList`;

  const result = await runAppleScript(buildScript(body), 40_000);

  let parsed: string[];
  try {
    parsed = JSON.parse(result.stdout) as string[];
  } catch {
    throw new MusicToolError(
      "script_error",
      "Music returned an invalid non-empty folder payload.",
      { outputLength: result.stdout.length },
    );
  }

  return new Set(parsed.map((id) => id.trim()).filter((id) => id.length > 0));
}

async function createFolder(input: { name: string; parentId?: string }): Promise<Folder> {
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

  const result = await runAppleScript(buildScript(body), 40_000);

  let parsed: { id: string; name: string; parentId: string };
  try {
    parsed = JSON.parse(result.stdout) as { id: string; name: string; parentId: string };
  } catch {
    throw new MusicToolError("script_error", "Music returned an invalid create folder payload.", {
      outputLength: result.stdout.length,
    });
  }

  const parentId = parsed.parentId.trim();
  const folder: Folder = {
    id: parsed.id,
    name: parsed.name,
    isRoot: parentId.length === 0,
  };
  if (parentId.length > 0) {
    folder.parentId = parentId;
  }
  return folder;
}
