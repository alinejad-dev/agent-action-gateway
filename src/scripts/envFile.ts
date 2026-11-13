// Changes the value of existing KEY=value lines in .env-style text.
// Pure function (no file access), so it is unit-tested without touching a real .env.
// Everything else in the text stays byte for byte the same, including line endings.
// Error messages name the variable only, never a value (values may be secrets).

export class EnvFileError extends Error {}

const KEY_NAME = /^[A-Z][A-Z0-9_]*$/;

// Values we write need no quoting or escaping in a .env file.
const SAFE_VALUE = /^[A-Za-z0-9._-]+$/;

export function replaceEnvValues(text: string, updates: Record<string, string>): string {
  const lines = text.split('\n');

  for (const [key, value] of Object.entries(updates)) {
    if (!KEY_NAME.test(key)) {
      throw new EnvFileError(`${key}: not a valid variable name`);
    }
    if (!SAFE_VALUE.test(value)) {
      throw new EnvFileError(`${key}: the new value has characters that are not safe in a .env file`);
    }

    // Every line that sets this variable in any spelling Node accepts
    // (leading spaces, "export ", spaces before "="). Comment lines do not match.
    const anySpelling = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
    const found: number[] = [];
    lines.forEach((line, index) => {
      if (anySpelling.test(line)) {
        found.push(index);
      }
    });

    const index = found[0];
    const line = index === undefined ? undefined : lines[index];
    if (found.length !== 1 || index === undefined || line === undefined) {
      throw new EnvFileError(`${key}: expected exactly one line that sets it, found ${found.length}`);
    }
    if (!line.startsWith(`${key}=`)) {
      throw new EnvFileError(`${key}: the line must start with "${key}=" (no spaces, no "export")`);
    }

    // Keep a Windows line ending (CRLF) if the line had one.
    const carriageReturn = line.endsWith('\r') ? '\r' : '';
    lines[index] = `${key}=${value}${carriageReturn}`;
  }

  return lines.join('\n');
}