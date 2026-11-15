// Asks for a secret in the terminal without showing it. The only feedback is how many
// characters were received so far, so the user can see that a paste arrived.
// Used by admin scripts so a key never appears on screen, in the shell history,
// or in a file opened in an editor.

export class PromptCancelled extends Error {}

export type FeedResult = { state: 'more' | 'done' | 'cancelled'; buffer: string };

// Pure part (unit-tested): add one chunk of terminal input to what was typed so far.
// A paste arrives as one chunk with many characters.
export function feedSecretInput(buffer: string, chunk: string): FeedResult {
  let next = buffer;
  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      // Enter. Anything after it in this chunk is dropped on purpose.
      return { state: 'done', buffer: next };
    }
    if (char === '\u0003' || char === '\u0004') {
      // Ctrl+C / Ctrl+D
      return { state: 'cancelled', buffer: '' };
    }
    if (char === '\u007f' || char === '\b') {
      // Backspace
      next = next.slice(0, -1);
      continue;
    }
    next += char;
  }
  return { state: 'more', buffer: next };
}

// Pure part (unit-tested): remove what a terminal may add around a paste.
// - escape sequences such as the "bracketed paste" markers ESC[200~ and ESC[201~
// - any other control character, and spaces at both ends
export function cleanSecretInput(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;]*[A-Za-z~]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

// True when input comes from a real terminal (not a pipe or a redirect).
export function canPromptSecret(): boolean {
  return process.stdin.isTTY === true && typeof process.stdin.setRawMode === 'function';
}

// Shows the label and a live character count, reads until Enter, returns the cleaned text.
// Works only in a real terminal: piped input is refused so nobody is tempted to put
// a secret into a command line (it would be saved in the shell history).
export function promptSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!canPromptSecret()) {
    return Promise.reject(new Error('This command needs an interactive terminal (no pipes or redirects).'));
  }

  return new Promise<string>((resolve, reject) => {
    let buffer = '';

    // Rewrites the same line: "\r" moves to its start, the spaces at the end wipe
    // what is left of a longer earlier text. Only the count is shown, never the input.
    const showCount = (): void => {
      const count = cleanSecretInput(buffer).length;
      process.stdout.write(`\r${label}${count} characters received  `);
    };

    const stop = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: string): void => {
      const result = feedSecretInput(buffer, chunk);
      buffer = result.buffer;
      if (result.state === 'more') {
        showCount();
        return;
      }
      stop();
      if (result.state === 'cancelled') {
        reject(new PromptCancelled('Cancelled.'));
      } else {
        resolve(cleanSecretInput(buffer));
      }
    };

    showCount();
    stdin.setEncoding('utf8');
    // Raw mode: the terminal no longer echoes what is typed or pasted.
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}