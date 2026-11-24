import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPool, poolOptions, resolveDbSettings, type DbSettings } from '../src/db/dbSettings.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const PASSWORD = 'p4ss-never-printed';

// A complete, valid environment; each case below changes one thing.
function validEnv(): Record<string, string | undefined> {
  return {
    DB_HOST: 'db.example.test',
    DB_PORT: '5432',
    DB_NAME: 'postgres',
    DB_USER: 'gateway_app.abc',
    DB_PASSWORD: PASSWORD,
    DB_CA_CERT: 'certs/ca.crt',
  };
}

// A fake file reader that records which paths were asked for.
function fakeReader(content: string | Error) {
  const paths: string[] = [];
  const readTextFile = (path: string): string => {
    paths.push(path);
    if (content instanceof Error) {
      throw content;
    }
    return content;
  };
  return { paths, readTextFile };
}

function problemsOf(env: Record<string, string | undefined>, content: string | Error = PEM): string[] {
  const result = resolveDbSettings(env, { projectRoot: '/project', readTextFile: fakeReader(content).readTextFile });
  if (result.ok) {
    throw new Error('expected problems');
  }
  return result.problems;
}

describe('resolveDbSettings', () => {
  it('returns null when no DB_* variable is set (database not configured)', () => {
    const reader = fakeReader(PEM);
    const result = resolveDbSettings({ WOO_BASE_URL: 'http://localhost:8080' }, { readTextFile: reader.readTextFile });
    expect(result).toEqual({ ok: true, settings: null });
    expect(reader.paths).toEqual([]);
  });

  it('treats empty DB_* variables as not set', () => {
    const env = Object.fromEntries(Object.keys(validEnv()).map((name) => [name, '']));
    expect(resolveDbSettings(env, { readTextFile: fakeReader(PEM).readTextFile })).toEqual({
      ok: true,
      settings: null,
    });
  });

  it('returns frozen settings and reads the CA from the project root', () => {
    const reader = fakeReader(PEM);
    const result = resolveDbSettings(validEnv(), { projectRoot: '/project', readTextFile: reader.readTextFile });
    expect(result).toEqual({
      ok: true,
      settings: {
        host: 'db.example.test',
        port: 5432,
        database: 'postgres',
        user: 'gateway_app.abc',
        password: PASSWORD,
        ca: PEM,
      },
    });
    // resolve() so the test passes on Windows too (there the path starts with a drive letter).
    expect(reader.paths).toEqual([resolve('/project', 'certs/ca.crt')]);
    expect(result.ok && result.settings !== null && Object.isFrozen(result.settings)).toBe(true);
  });

  it('uses port 5432 and database "postgres" when they are not set', () => {
    const env = validEnv();
    delete env.DB_PORT;
    delete env.DB_NAME;
    const result = resolveDbSettings(env, { projectRoot: '/project', readTextFile: fakeReader(PEM).readTextFile });
    expect(result.ok && result.settings).toMatchObject({ port: 5432, database: 'postgres' });
  });

  it.each(['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_CA_CERT'])('refuses settings without %s', (name) => {
    const env = validEnv();
    delete env[name];
    expect(problemsOf(env).some((problem) => problem.startsWith(`${name}: `))).toBe(true);
  });

  it('refuses a half configuration: only DB_PORT set names all four missing variables', () => {
    const names = problemsOf({ DB_PORT: '5432' }).map((problem) => problem.split(':')[0]);
    expect(names).toEqual(['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_CA_CERT']);
  });

  it.each(['abc', '0', '65536', '54.3'])('refuses DB_PORT %j', (port) => {
    const env = validEnv();
    env.DB_PORT = port;
    expect(problemsOf(env).some((problem) => problem.startsWith('DB_PORT: '))).toBe(true);
  });

  it('does not read the CA file when a variable is wrong', () => {
    const env = validEnv();
    env.DB_PORT = 'abc';
    const reader = fakeReader(PEM);
    expect(resolveDbSettings(env, { readTextFile: reader.readTextFile }).ok).toBe(false);
    expect(reader.paths).toEqual([]);
  });

  it('refuses a CA file that cannot be read', () => {
    expect(problemsOf(validEnv(), new Error('ENOENT'))).toEqual([
      'DB_CA_CERT: file not found, not readable, or not a PEM certificate',
    ]);
  });

  it('refuses a CA file that is not a PEM certificate', () => {
    expect(problemsOf(validEnv(), 'not a certificate')).toEqual([
      'DB_CA_CERT: file not found, not readable, or not a PEM certificate',
    ]);
  });

  it('never puts a value into a problem', () => {
    const env = validEnv();
    env.DB_PORT = 'port-value-never-printed';
    const all = [...problemsOf(env), ...problemsOf(validEnv(), 'not a certificate')].join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('port-value-never-printed');
    expect(all).not.toContain('certs/ca.crt');
  });
});

const SETTINGS: DbSettings = {
  host: 'db.example.test',
  port: 5432,
  database: 'postgres',
  user: 'gateway_app.abc',
  password: PASSWORD,
  ca: PEM,
};

describe('poolOptions', () => {
  it('verifies TLS with the given CA and keeps the agreed limits', () => {
    const options = poolOptions(SETTINGS);
    expect(options).toEqual({
      host: 'db.example.test',
      port: 5432,
      database: 'postgres',
      user: 'gateway_app.abc',
      password: PASSWORD,
      ssl: { ca: PEM },
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
    });
  });
});

describe('createPool', () => {
  it('creates a pool with these options and an error handler, without connecting', async () => {
    const pool = createPool(SETTINGS);
    expect(pool.options.max).toBe(5);
    expect(pool.options.ssl).toEqual({ ca: PEM });
    expect(pool.listenerCount('error')).toBe(1);
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });
});