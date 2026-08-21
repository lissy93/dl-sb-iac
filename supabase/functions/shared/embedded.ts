/** PostgREST types many-to-one embeds as arrays but returns a single row, so normalise both */
export function one<T>(embed: T | T[] | null | undefined): T | undefined {
  return Array.isArray(embed) ? embed[0] : embed ?? undefined;
}
