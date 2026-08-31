import { Console, Context, Effect, Layer } from "effect"
import { encode } from "uqr"

/**
 * Prints a scannable QR code for a URL to stderr. A service rather than a call
 * so the entry point decides once whether stderr is a terminal and a test can
 * render without one: `--qr` into a pipe is a silent no-op, because the URL on
 * stdout is the product and nothing is looking at the pipe's stderr.
 */
export class Qr extends Context.Service<
  Qr,
  { readonly print: (url: string) => Effect.Effect<void> }
>()("handbill/Qr") {}

/** Outside the matrix counts as light: the dangling half-row of an odd-sized code. */
const dark = (data: ReadonlyArray<ReadonlyArray<boolean>>, row: number, col: number) =>
  data[row]?.[col] ?? false

/**
 * Half-block rendering, two module rows per character line, pinned to black
 * ink on a white field with SGR: scanners are specified to read dark-on-light,
 * and uqr's own terminal renderers follow the theme instead, which inverts the
 * code wherever the background is light. `border: 4` is the quiet zone the QR
 * spec asks for, part of the printed field so the surrounding screen cannot
 * take it away. `ecc: "M"` is free at URL lengths like these and buys camera
 * headroom.
 */
export const render = (url: string): string => {
  const { data, size } = encode(url, { border: 4, ecc: "M" })
  const lines: Array<string> = []
  for (let row = 0; row < size; row += 2) {
    let cells = ""
    for (let col = 0; col < size; col++) {
      const top = dark(data, row, col)
      const bottom = dark(data, row + 1, col)
      cells += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " "
    }
    lines.push(`\u001B[30;47m${cells}\u001B[0m`)
  }
  return lines.join("\n")
}

export const layer = (options: { readonly tty: boolean }) =>
  Layer.succeed(Qr, {
    print: (url) => (options.tty ? Console.error(render(url)) : Effect.void)
  })

/** What the published CLI runs with: stderr's TTY-ness at startup. */
export const QrLive = layer({ tty: process.stderr.isTTY === true })
