import type { MessageKey } from './i18n';
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    public messageKey: MessageKey = 'invalidInput',
    public details?: unknown,
  ) {
    super(code);
  }
}
export const notFound = () => new AppError(404, 'NOT_FOUND', 'notFound');
export const conflict = () => new AppError(409, 'VERSION_CONFLICT', 'conflict');
export function assert(
  condition: unknown,
  code = 'INVALID_INPUT',
  details?: unknown,
): asserts condition {
  if (!condition) throw new AppError(422, code, 'invalidInput', details);
}
