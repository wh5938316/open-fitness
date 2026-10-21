function escapedLike(query: string): string {
  return query.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
export function containsLike(query: string): string {
  return `%${escapedLike(query)}%`;
}
export function prefixLike(query: string): string {
  return `${escapedLike(query)}%`;
}
