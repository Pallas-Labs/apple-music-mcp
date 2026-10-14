import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import * as z from "zod/v4";

import type { ExecFn } from "../applescript/runner.js";
import { readParentIds } from "./playlist-tree.js";

test("readParentIds splits large reads across processes and keeps each parent with its ID", async () => {
  const ids = Array.from(
    { length: 60 },
    (_, index) => `ID${String(index).padStart(14, "0")}`
  );
  const chunkSizes: number[] = [];
  // Answer each process with "P" + ID, in reverse order of arrival, so mismatched joins would show.
  const execFn: ExecFn = async (script) => {
    const chunk = z
      .array(z.string())
      .parse(
        JSON.parse(/(?<ids>\[[^\]]*\])\.map/u.exec(script)?.groups?.ids ?? "[]")
      );
    chunkSizes.push(chunk.length);
    await sleep(60 - chunkSizes.length * 10);
    return { stderr: "", stdout: JSON.stringify(chunk.map((id) => `P${id}`)) };
  };

  const parents = await readParentIds(ids, execFn);

  expect(chunkSizes).toEqual([20, 20, 20]);
  expect([...parents]).toEqual(ids.map((id) => [id, `P${id}`]));
});
