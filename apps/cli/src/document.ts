import { Effect, FileSystem, Stdio, Stream } from "effect"
import { hashDocument } from "./hash"
import * as Markdown from "./markdown"

/** The bytes behind the publish argument: a file, or stdin when it is `-`. */
const readBytes = Effect.fn(function* (file: string) {
  if (file !== "-") {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFile(file)
  }
  const stdio = yield* Stdio.Stdio
  const chunks = yield* Stream.runCollect(stdio.stdin)
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
})

/**
 * What `handbill <file>` uploads, and the hash that names it. Markdown becomes
 * one self-contained page here, in the CLI, so the Worker only ever stores HTML;
 * everything else goes up exactly as it was read. The hash is taken after
 * rendering, because the rendered bytes are the ones the server will see.
 */
export const load = Effect.fn(function* (options: {
  readonly file: string
  readonly markdown: boolean
}) {
  const read = yield* readBytes(options.file)
  const bytes =
    options.markdown || Markdown.isMarkdownFile(options.file)
      ? new TextEncoder().encode(Markdown.render(new TextDecoder().decode(read), options.file))
      : read
  return { bytes, hash: hashDocument(bytes) }
})
