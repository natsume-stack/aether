import { parseError } from '../../../script/parse-error';

export function parseIvmError(error: Error) {
  return parseError(error, '<isolated-vm boundary>');
}
