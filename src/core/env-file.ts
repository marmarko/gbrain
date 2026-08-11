/**
 * Load `<configDir()>/env` into `process.env`.
 *
 * The file is a long-standing gbrain convention — it lives in gbrain's own
 * config directory and holds provider credentials — but nothing in gbrain ever
 * read it. It worked only because users source it from a shell rc
 * (`[ -f "$HOME/.gbrain/env" ] && . "$HOME/.gbrain/env"`). Any gbrain process
 * started outside that interactive shell — launchd, cron, a desktop MCP client
 * spawning `gbrain serve`, a CI runner — saw no keys at all and failed with
 * opaque provider auth errors that look like a bad key rather than a missing
 * one.
 *
 * PRECEDENCE: the real environment always wins. A variable already present in
 * `process.env` is never overwritten, so `FOO=x gbrain …`, container service
 * variables, and CI secrets all still beat the file. That ordering also makes
 * this safe to call unconditionally at startup: it can only ever fill gaps.
 *
 * Fail-open by construction. A missing, unreadable, or malformed file is a
 * no-op — credentials arriving some other way must keep working, and a parse
 * bug here must never stop the CLI from booting.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { configDir } from './config.ts';
import { join } from 'path';

export interface EnvFileResult {
  /** Absolute path examined (whether or not it existed). */
  path: string;
  /** Names applied to process.env. Values are never returned or logged. */
  applied: string[];
  /** Names present in the file but skipped because the environment already set them. */
  skipped: string[];
}

/**
 * Parse env-file text into key/value pairs.
 *
 * Deliberately a small subset of shell, not a shell: `export K=V` and `K=V`,
 * with optional single or double quotes, `#` comments, and blank lines. No
 * interpolation, no command substitution, no multi-line values — this file
 * holds credentials, and a parser that evaluated `$(…)` would turn a config
 * file into an execution vector.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;

    const key = m[1];
    let value = m[2].trim();

    // Strip one matched layer of quotes. Unquoted values additionally drop a
    // trailing ` # comment`, which a quoted value must be able to contain.
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out.set(key, value);
  }
  return out;
}

/**
 * Read `<configDir()>/env` and fill in any variable the environment lacks.
 *
 * `dir` is injectable for tests; callers use the default.
 */
export function loadGbrainEnvFile(dir: string = configDir()): EnvFileResult {
  const path = join(dir, 'env');
  const result: EnvFileResult = { path, applied: [], skipped: [] };

  try {
    if (!existsSync(path)) return result;

    // The file holds credentials. Warn — but do not refuse — when it is
    // readable beyond the owner, matching how gbrain treats other secret
    // material: loud enough to fix, never load-bearing on a mode bit that a
    // restore, a sync tool, or a checkout may have widened.
    try {
      const mode = statSync(path).mode & 0o077;
      if (mode !== 0) {
        console.error(
          `[gbrain] WARNING: ${path} is readable beyond its owner (mode ${(statSync(path).mode & 0o777).toString(8)}). ` +
            `It holds provider credentials — run: chmod 600 ${path}`,
        );
      }
    } catch {
      // stat failure is not a reason to skip the load.
    }

    for (const [key, value] of parseEnvFile(readFileSync(path, 'utf8'))) {
      if (process.env[key] !== undefined) {
        result.skipped.push(key);
        continue;
      }
      process.env[key] = value;
      result.applied.push(key);
    }
  } catch {
    // Fail-open: unreadable or malformed file must not stop the CLI booting.
  }

  return result;
}
