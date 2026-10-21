export function containsLike(query: string): string {
  return (
    '%' +
    query.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') +
    '%'
  );
}
