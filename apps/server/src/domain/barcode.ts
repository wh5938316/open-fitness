import { AppError } from '../errors';

/** UPC-A (12) becomes EAN-13. GTIN-8 and GTIN-14 stay as written. */
export function normalizeBarcode(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 12) return `0${digits}`;
  if (digits.length === 8 || digits.length === 13 || digits.length === 14) return digits;
  return null;
}

export function requireBarcode(input: string): string {
  const code = normalizeBarcode(input);
  if (!code) throw new AppError(422, 'INVALID_BARCODE', 'invalidBarcode');
  return code;
}

export function barcodeFromReference(reference?: string | null): string | null {
  if (!reference) return null;
  const marker = '/product/';
  const start = reference.indexOf(marker);
  if (start < 0) return null;
  const rest = reference.slice(start + marker.length);
  const end = rest.search(/[/?#]/);
  const segment = end === -1 ? rest : rest.slice(0, end);
  try {
    return normalizeBarcode(decodeURIComponent(segment));
  } catch {
    return normalizeBarcode(segment);
  }
}
