import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { aioHome, configPath, configPathIn, dbPath, packagesDir, tmpDir, updateCheckPath } from '.';

const original = process.env.AIO_PROXY_HOME;

function withNodeEnv(value: string, run: () => void): void {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    run();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

afterEach(() => {
  if (original === undefined) {
    delete process.env.AIO_PROXY_HOME;
  } else {
    process.env.AIO_PROXY_HOME = original;
  }
});

describe('paths', () => {
  test('AIO_PROXY_HOME override drives every derived path', () => {
    process.env.AIO_PROXY_HOME = '/tmp/foo';
    expect(aioHome()).toBe('/tmp/foo');
    expect(configPath()).toBe('/tmp/foo/config.jsonc');
    expect(dbPath()).toBe('/tmp/foo/aio-proxy.db');
    expect(packagesDir()).toBe('/tmp/foo/packages');
    expect(tmpDir()).toBe('/tmp/foo/tmp');
    expect(updateCheckPath()).toBe('/tmp/foo/update-check.json');
  });

  // Under bun test the guard refuses the real home, so observe the fallback from
  // a plain `bun -e` process with a throwaway HOME.
  test('absent or empty AIO_PROXY_HOME falls back to ~/.aio-proxy outside tests', () => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-paths-home-'));
    try {
      for (const override of [undefined, '']) {
        const env: Record<string, string | undefined> = { ...process.env, HOME: home, AIO_PROXY_HOME: override };
        delete env['NODE_ENV'];
        const result = Bun.spawnSync(
          [
            process.execPath,
            '-e',
            `const p = await import(${JSON.stringify(import.meta.resolve('.'))}); console.log(p.aioHome(), p.configPath())`,
          ],
          { env },
        );
        expect(result.stdout.toString().trim()).toBe(
          `${join(home, '.aio-proxy')} ${join(home, '.aio-proxy', 'config.jsonc')}`,
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Regression: an unisolated test once overwrote the real models.dev cache.
  test('refuses the real home under bun test, so no test can write there', () => {
    // `production` mimics an inherited NODE_ENV that `bun test` preserves.
    for (const nodeEnv of ['test', 'production']) {
      withNodeEnv(nodeEnv, () => {
        for (const value of [undefined, '', join(homedir(), '.aio-proxy'), `${homedir()}/x/../.aio-proxy/`]) {
          if (value === undefined) delete process.env.AIO_PROXY_HOME;
          else process.env.AIO_PROXY_HOME = value;
          expect(() => tmpDir()).toThrow('Refusing to use the real aio-proxy home');
        }
      });
    }
  });

  // homedir() ignores later HOME changes, so alias a throwaway home from a child.
  test('refuses a symlink that aliases the real home under test', () => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-paths-symlink-'));
    try {
      mkdirSync(join(home, '.aio-proxy'));
      symlinkSync(join(home, '.aio-proxy'), join(home, 'alias'));
      const result = Bun.spawnSync(
        [process.execPath, '-e', `const p = await import(${JSON.stringify(import.meta.resolve('.'))}); p.aioHome();`],
        { env: { ...process.env, HOME: home, NODE_ENV: 'test', AIO_PROXY_HOME: join(home, 'alias') } },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain('Refusing to use the real aio-proxy home');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('derived paths end with the correct basenames', () => {
    process.env.AIO_PROXY_HOME = '/tmp/foo';
    expect(configPath().endsWith('/config.jsonc')).toBe(true);
    expect(dbPath().endsWith('/aio-proxy.db')).toBe(true);
    expect(packagesDir().endsWith('/packages')).toBe(true);
    expect(tmpDir().endsWith('/tmp')).toBe(true);
    expect(updateCheckPath().endsWith('/update-check.json')).toBe(true);
  });

  test('selects the first existing config file by format priority', () => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-paths-'));
    process.env.AIO_PROXY_HOME = home;
    const names = ['config.json', 'config.jsonc', 'config.yaml', 'config.yml'];

    try {
      for (const name of names) {
        writeFileSync(join(home, name), '{}');
        expect(configPath()).toBe(join(home, name));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('does not discover TOML config', () => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-paths-'));
    process.env.AIO_PROXY_HOME = home;

    try {
      writeFileSync(join(home, 'config.toml'), '[server]\nport = 22078\n');
      expect(configPath()).toBe(join(home, 'config.jsonc'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('configPathIn finds the existing config file inside an explicit home', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-home-'));
  try {
    writeFileSync(join(home, 'config.yaml'), 'providers: {}\n');
    expect(configPathIn(home)).toBe(join(home, 'config.yaml'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
