import type { DiagnosticData } from "./types.js";

export const log = (event: string, data: DiagnosticData): void => {
  console.error(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      ...data,
    })
  );
};
