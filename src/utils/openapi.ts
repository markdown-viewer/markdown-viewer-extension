import { stripUrlQueryAndHash } from './document-url';
import { parse } from 'yaml';

/**
 * Is this path spelled as a YAML document? `.ya?ml` is not a registered format
 * (OpenAPI is a document capability), so its extension is decided here and in
 * the hosts that offer a preview for it.
 */
export function isYamlFilePath(path: string): boolean {
  return /\.ya?ml$/i.test(stripUrlQueryAndHash(path));
}

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
  return isYamlFilePath(path) && isOpenapiSource(content);
}
