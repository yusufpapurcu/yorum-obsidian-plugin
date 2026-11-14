/** Yields the `data:` payload of each server-sent event; tolerates chunks split mid-line. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const takeLines = function* (final: boolean) {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? "" : lines.pop()!;
    for (const line of lines) {
      if (line === "") {
        if (data.length) yield data.join("\n");
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    yield* takeLines(false);
  }
  buffer += decoder.decode();
  yield* takeLines(true);
  if (data.length) yield data.join("\n");
}
