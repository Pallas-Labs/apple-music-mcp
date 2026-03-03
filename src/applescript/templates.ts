const PREAMBLE = `
try
    if application "Music" is not running then
        tell application "Music" to launch
    end if
end try

repeat with i from 1 to 50
    if application "Music" is running then exit repeat
    delay 0.1
end repeat
`;

const SHARED_HANDLERS = `
on jsonEscape(sourceText)
    set bs to (ASCII character 92)
    set sourceText to my replaceText(bs, bs & bs, sourceText)
    set sourceText to my replaceText(quote, bs & quote, sourceText)
    set sourceText to my replaceText(return, "\\n", sourceText)
    set sourceText to my replaceText(linefeed, "\\n", sourceText)
    set sourceText to my replaceText(tab, "\\t", sourceText)
    return sourceText
end jsonEscape

on replaceText(findText, replaceText, sourceText)
    set tid to AppleScript's text item delimiters
    set AppleScript's text item delimiters to findText
    set textItems to text items of sourceText
    set AppleScript's text item delimiters to replaceText
    set sourceText to textItems as text
    set AppleScript's text item delimiters to tid
    return sourceText
end replaceText
`;

/**
 * Build a complete AppleScript from a body block.
 * Prepends the "ensure Music is running" preamble and appends shared JSON handlers.
 */
export function buildScript(body: string): string {
  return `${PREAMBLE}\n${body}\n${SHARED_HANDLERS}`;
}

/** Build a script that doesn't need the Music preamble (e.g. health checks). */
export function buildRawScript(body: string): string {
  return body;
}
