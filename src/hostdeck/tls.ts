import { createSecureContext } from 'node:tls';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_BACKEND_PFX_BYTES = 1024 * 1024;

/**
 * Load a backend certificate generated for the local reverse-proxy trust boundary.
 * The private key remains in the protected installed state directory; callers must
 * never expose this PFX or use it as a public-facing Caddy certificate.
 */
export async function loadBackendTls(options: { pfxFile: string }): Promise<{ pfx: Buffer }> {
  if (!path.isAbsolute(options.pfxFile)) throw new Error('TLS_PFX_PATH_MUST_BE_ABSOLUTE');
  const file = path.resolve(options.pfxFile);
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('TLS_PFX_FILE_INVALID');
  if (stat.size < 1 || stat.size > MAX_BACKEND_PFX_BYTES) throw new Error('TLS_PFX_SIZE_INVALID');
  const pfx = await fs.readFile(file);
  if (pfx.length !== stat.size || pfx.length > MAX_BACKEND_PFX_BYTES) throw new Error('TLS_PFX_SIZE_INVALID');
  try { createSecureContext({ pfx, passphrase: '' }); }
  catch { pfx.fill(0); throw new Error('TLS_PFX_INVALID'); }
  return { pfx };
}
