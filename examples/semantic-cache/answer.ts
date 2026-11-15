/** The answer a request gets when it is answered right: shared by the cases (as expected) and the stand-in model. */
export type Request = { id: number; text: string; intent: string; entity: number | string | null }

export const answer = (intent: string, entity: number | string | null): string =>
  entity === null ? `the answer to ${intent}` : `the answer to ${intent} for ${entity}`
