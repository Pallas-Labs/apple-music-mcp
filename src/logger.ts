export function log(event: string, data: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      ...data,
    })
  );
}
