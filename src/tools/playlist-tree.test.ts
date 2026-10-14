import { expect, test } from "bun:test";

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
    const chunk = JSON.parse(
      (/(\[[^\]]*\])\.map/.exec(script))?.[1] ?? "[]"
    ) as string[];
    chunkSizes.push(chunk.length);
    await new Promise((resolve) =>
      setTimeout(resolve, 60 - chunkSizes.length * 10)
    );
    return { stderr: "", stdout: JSON.stringify(chunk.map((id) => `P${id}`)) };
  };

  const parents = await readParentIds(ids, execFn);

  expect(chunkSizes).toEqual([20, 20, 20]);
  expect([...parents]).toEqual(ids.map((id) => [id, `P${id}`]));
});
