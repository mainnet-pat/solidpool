/**
 * An error written for the person using the page. Anything else came from a server, a
 * wallet or a library, and the page logs it instead of showing it: a hostile server's
 * words must never read as the page's own instructions.
 */
export class Notice extends Error {
  readonly notice = true;

  /** `unsent` says no transaction left this page, so trying again with the same note is safe. */
  constructor(message: string, readonly unsent = false) {
    super(message);
  }
}
