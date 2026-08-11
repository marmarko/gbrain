import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseEnvFile, loadGbrainEnvFile } from '../src/core/env-file.ts';

const dirs: string[] = [];
function envDir(contents: string, mode = 0o600): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-envfile-'));
  dirs.push(d);
  const f = join(d, 'env');
  writeFileSync(f, contents);
  chmodSync(f, mode);
  return d;
}

const touched: string[] = [];
function trackDelete(...keys: string[]) {
  touched.push(...keys);
}

afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  test('parses export and bare assignment', () => {
    const m = parseEnvFile("export A=1\nB=2\n");
    expect(m.get('A')).toBe('1');
    expect(m.get('B')).toBe('2');
  });

  test('strips one layer of single or double quotes', () => {
    const m = parseEnvFile(`export A='v1'\nexport B="v2"\n`);
    expect(m.get('A')).toBe('v1');
    expect(m.get('B')).toBe('v2');
  });

  test('ignores comments and blank lines', () => {
    const m = parseEnvFile('# lead\n\n  \nexport A=1\n# trail\n');
    expect([...m.keys()]).toEqual(['A']);
  });

  test('drops trailing comment on unquoted values but keeps # inside quotes', () => {
    const m = parseEnvFile(`A=plain # note\nB='has # hash'\n`);
    expect(m.get('A')).toBe('plain');
    expect(m.get('B')).toBe('has # hash');
  });

  test('does not interpolate or execute — the file holds credentials', () => {
    const m = parseEnvFile('A=$(whoami)\nB=${HOME}\n');
    expect(m.get('A')).toBe('$(whoami)');
    expect(m.get('B')).toBe('${HOME}');
  });

  test('skips malformed lines without throwing', () => {
    const m = parseEnvFile('not an assignment\n9INVALID=x\nexport OK=1\n');
    expect(m.get('OK')).toBe('1');
    expect(m.has('9INVALID')).toBe(false);
  });

  test('keeps values containing = (URLs with query strings)', () => {
    const m = parseEnvFile("export U='https://h/db?sslmode=require&x=1'\n");
    expect(m.get('U')).toBe('https://h/db?sslmode=require&x=1');
  });
});

describe('loadGbrainEnvFile', () => {
  test('applies variables the environment lacks', () => {
    trackDelete('GBRAIN_TEST_APPLIED');
    const d = envDir("export GBRAIN_TEST_APPLIED='from-file'\n");
    const r = loadGbrainEnvFile(d);
    expect(process.env.GBRAIN_TEST_APPLIED).toBe('from-file');
    expect(r.applied).toContain('GBRAIN_TEST_APPLIED');
  });

  test('never overwrites an already-set variable — the real env wins', () => {
    trackDelete('GBRAIN_TEST_PRESET');
    process.env.GBRAIN_TEST_PRESET = 'from-env';
    const d = envDir("export GBRAIN_TEST_PRESET='from-file'\n");
    const r = loadGbrainEnvFile(d);
    expect(process.env.GBRAIN_TEST_PRESET).toBe('from-env');
    expect(r.skipped).toContain('GBRAIN_TEST_PRESET');
    expect(r.applied).not.toContain('GBRAIN_TEST_PRESET');
  });

  test('missing file is a no-op, not an error', () => {
    const d = mkdtempSync(join(tmpdir(), 'gbrain-envfile-none-'));
    dirs.push(d);
    const r = loadGbrainEnvFile(d);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  test('never returns secret values, only names', () => {
    trackDelete('GBRAIN_TEST_SECRET');
    const d = envDir("export GBRAIN_TEST_SECRET='super-secret-value'\n");
    const r = loadGbrainEnvFile(d);
    expect(JSON.stringify(r)).not.toContain('super-secret-value');
  });

  test('loads a group-readable file but warns about the mode', () => {
    trackDelete('GBRAIN_TEST_LOOSE');
    const d = envDir("export GBRAIN_TEST_LOOSE='v'\n", 0o644);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
    try {
      loadGbrainEnvFile(d);
    } finally {
      console.error = orig;
    }
    // Fail-open: a widened mode bit must not withhold credentials.
    expect(process.env.GBRAIN_TEST_LOOSE).toBe('v');
    expect(errs.join('\n')).toMatch(/readable beyond its owner/);
  });
});
