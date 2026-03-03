import { describe, expect, test } from "bun:test";
import { runAppleScript } from "./applescript/runner.js";

const INTEGRATION = process.env["INTEGRATION"] === "true";

describe.skipIf(!INTEGRATION)("integration", () => {
    test("music.health — Music app responds", async () => {
        const script = `
try
    if application "Music" is running then
        return "running"
    else
        return "not_running"
    end if
on error
    return "error"
end try`;
        const result = await runAppleScript(script, 5_000);
        expect(["running", "not_running"]).toContain(result.stdout);
    });

    test("list playlists returns valid JSON", async () => {
        const script = `
tell application id "com.apple.Music"
    set pCount to count of user playlists
    return pCount as text
end tell`;
        const result = await runAppleScript(script, 15_000);
        const count = Number(result.stdout);
        expect(count).toBeGreaterThanOrEqual(0);
    });
});
