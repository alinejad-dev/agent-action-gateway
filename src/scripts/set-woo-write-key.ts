// Stores the WooCommerce write key (Read/Write) in .env without showing it (admin tool,
// never imported by the server).
//   npm run woo-write-key:status  -> read-only: is the write key in .env, and does it look right?
//   npm run woo-write-key:set     -> asks for the key and the secret (hidden input), writes .env
// The key is never printed, never passed on a command line (shell history) and never
// typed into an editor. Only its length is shown.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeKeyProblem, resolveWriteKeys, type KeyPart } from '../woo/keys.js';
import { upsertEnvValues } from './envFile.js';
import { canPromptSecret, promptSecret, PromptCancelled } from './promptSecret.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const envPath = resolve(projectRoot, '.env');
const envTempPath = resolve(projectRoot, '.env.tmp'); // gitignored by ".env.*"

const KEY_VAR = 'WOO_WRITE_CONSUMER_KEY';
const SECRET_VAR = 'WOO_WRITE_CONSUMER_SECRET';
const PROMPT_ATTEMPTS = 3;

class ScriptError extends Error {}

// ---------- 1. Arguments and the .env file ----------

const mode = process.argv[2];
if (mode !== 'status' && mode !== 'set') {
  console.error('Usage: tsx src/scripts/set-woo-write-key.ts <status|set>');
  process.exit(1);
}

function readEnvFile(): string {
  try {
    return readFileSync(envPath, 'utf8');
  } catch {
    throw new ScriptError('Cannot read .env in the project root. Copy .env.example to .env first.');
  }
}

// Write a temporary file first, then rename it over .env: a crash in the middle
// can never leave a half-written .env (it also holds the other keys and the DB password).
function writeEnvFile(text: string): void {
  try {
    writeFileSync(envTempPath, text, 'utf8');
    renameSync(envTempPath, envPath);
  } catch (error) {
    try {
      rmSync(envTempPath, { force: true });
    } catch {
      // Keep the original error; a leftover .env.tmp is gitignored.
    }
    throw error;
  }
}

// Throws if .env sets one of the two variables more than once or in another spelling.
function withWriteKey(envText: string, key: string, secret: string): string {
  return upsertEnvValues(envText, { [KEY_VAR]: key, [SECRET_VAR]: secret });
}

// How many lines of the text set this variable (plain "NAME=" spelling at the start of a line).
function countLines(envText: string, name: string): number {
  return envText.split(/\r?\n/).filter((line) => line.startsWith(`${name}=`)).length;
}

// The values the server would see: same parser (process.loadEnvFile) as src/config.ts.
function loadValues(): Record<string, string | undefined> {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
  return process.env;
}

// ---------- 2. The two modes ----------

function describeValue(part: KeyPart, value: string): string {
  if (value === '') {
    return 'not set';
  }
  const problem = describeKeyProblem(part, value);
  return problem ? `set, but ${problem}` : `set (${value.length} characters, format ok)`;
}

function showStatus(): void {
  const envText = readEnvFile();
  withWriteKey(envText, 'placeholder', 'placeholder'); // Throws if the lines are ambiguous. Nothing is written.

  const env = loadValues();
  const key = env[KEY_VAR] ?? '';
  const secret = env[SECRET_VAR] ?? '';
  console.log(`${KEY_VAR}: ${describeValue('key', key)}`);
  console.log(`${SECRET_VAR}: ${describeValue('secret', secret)}`);

  const result = resolveWriteKeys(env);
  if (!result.ok) {
    for (const problem of result.problems) {
      console.log(`  - ${problem}`);
    }
    console.log('Result: NOT valid. The server will refuse to start. Run "npm run woo-write-key:set".');
    process.exitCode = 1;
    return;
  }
  if (result.keys === null) {
    console.log('Result: no write key (read-only setup). Run "npm run woo-write-key:set" to add it.');
    return;
  }
  console.log('Different from the read key (WOO_CONSUMER_KEY): yes');
  const strictProblem = describeKeyProblem('key', key) ?? describeKeyProblem('secret', secret);
  if (strictProblem) {
    console.log('Result: accepted by the server, but the format is unusual. Check it against WooCommerce.');
    process.exitCode = 1;
    return;
  }
  console.log('Result: write key is configured.');
}

// Asks until the value looks right (a few attempts). Never prints the value.
async function ask(part: KeyPart, label: string, sameAsRead: string | undefined): Promise<string> {
  for (let attempt = 1; attempt <= PROMPT_ATTEMPTS; attempt++) {
    const value = await promptSecret(`${label} (hidden): `);
    let problem = describeKeyProblem(part, value);
    if (!problem && value === sameAsRead) {
      problem = 'this is the READ key that is already in .env; the write key is a different one';
    }
    if (!problem) {
      console.log(`  ok: ${value.length} characters`);
      return value;
    }
    console.log(`  Not accepted: ${problem}.`);
  }
  throw new ScriptError(`No valid value after ${PROMPT_ATTEMPTS} attempts. Nothing was changed.`);
}

async function setKey(): Promise<void> {
  // Everything that can fail without asking for a secret comes first.
  if (!canPromptSecret()) {
    throw new ScriptError('This command needs an interactive terminal (no pipes or redirects). Nothing was changed.');
  }
  const envText = readEnvFile();
  withWriteKey(envText, 'placeholder', 'placeholder');
  const env = loadValues();
  const hadKey = countLines(envText, KEY_VAR) === 1;
  const hadSecret = countLines(envText, SECRET_VAR) === 1;

  console.log('Enter the WooCommerce key named "Action Gateway (write)" (permissions: Read/Write).');
  console.log('What you paste is not shown, only how many characters arrived (a key has 43).');
  console.log('Paste, check the count, then press Enter. Ctrl+C cancels without changing anything.');
  const key = await ask('key', 'Consumer key', env.WOO_CONSUMER_KEY);
  const secret = await ask('secret', 'Consumer secret', env.WOO_CONSUMER_SECRET);

  try {
    writeEnvFile(withWriteKey(envText, key, secret));
  } catch (error) {
    throw new ScriptError(`Could not write .env (${describe(error)}). Nothing was changed.`);
  }

  // Read the file back: both lines must be there exactly once.
  const written = readEnvFile();
  if (countLines(written, KEY_VAR) !== 1 || countLines(written, SECRET_VAR) !== 1) {
    throw new ScriptError('.env was written, but the two lines were not found when reading it back.');
  }
  console.log(`.env updated: ${KEY_VAR}=<${key.length} characters, not shown> (${hadKey ? 'line replaced' : 'line added'})`);
  console.log(`.env updated: ${SECRET_VAR}=<${secret.length} characters, not shown> (${hadSecret ? 'line replaced' : 'line added'})`);
  console.log('Now clear the clipboard, then run: npm run woo-write-key:status');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  if (mode === 'status') {
    showStatus();
  } else {
    await setKey();
  }
}

main().catch((error: unknown) => {
  if (error instanceof PromptCancelled) {
    console.error('Cancelled. Nothing was changed.');
  } else {
    console.error(`Failed: ${describe(error)}`);
  }
  process.exitCode = 1;
});