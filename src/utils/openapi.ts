import { stripUrlQueryAndHash } from './document-url';
import { parse } from 'yaml';

export function isOpenapiSource(content: string): boolean {
  try {
    const spec = parse(content);
    return (typeof spec?.openapi === 'string' && /^3\.\d+(?:\.\d+)?$/.test(spec.openapi))
      || spec?.swagger === '2.0';
  } catch {
    return false;
  }
}

export function isOpenapiFile(content: string, path: string): boolean {
  return /\.ya?ml$/i.test(stripUrlQueryAndHash(path)) && isOpenapiSource(content);
}
