// A refusal ends the launch with exit code 2 and no effect (A1.5, A6.10). The message is one line without the leading
// "refused: ", which the command adds. `tag` is set once the ticket tag has been established.
export class Refusal extends Error {
  constructor(message, tag = null) {
    super(message);
    this.name = 'Refusal';
    this.tag = tag;
  }
}

// Text from the outside (paths, names) is shown with control and non-ASCII characters escaped, so a message stays one line.
export const safe = value => String(value).replace(/[^\x20-\x7e]/gu, char => `\\u{${char.codePointAt(0).toString(16)}}`);
