/**
 * A problem the user can fix: a file, a flag, a setting. The command line
 * prints its message and exits 2, with no stack trace, because a stack trace
 * tells a stranger the tool broke when it was their file that did.
 */
export class UserError extends Error {}
