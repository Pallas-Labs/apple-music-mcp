export function log(event: string, data: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    }),
  );
}
