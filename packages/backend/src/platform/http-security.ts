import helmet from 'helmet';

/**
 * Express `trust proxy` value for `server.trustedProxies`. Empty keeps the
 * socket peer as the client address, so X-Forwarded-For cannot be spoofed.
 */
export function trustProxySetting(raw: string): string[] | false {
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : false;
}

/**
 * A forwarded request while no proxy is trusted means every client shares the
 * reverse proxy's address, so per-address login limits lock everyone out at
 * once. Warn the first time that is seen.
 */
export function warnOnUntrustedForwarding(trusted: string[] | false, warn: (message: string) => void) {
  let warned = trusted !== false;
  return (request: { headers: Record<string, unknown> }, _response: unknown, next: () => void): void => {
    if (!warned && (request.headers['x-forwarded-for'] !== undefined || request.headers.forwarded !== undefined)) {
      warned = true;
      warn('Received X-Forwarded-For but server.trustedProxies is empty: every client shares the '
        + "reverse proxy's address for login rate limits. Set TRUSTED_PROXIES (see OPERATIONS.md).");
    }
    next();
  };
}

/**
 * Response hardening for the API and the bundled SPA. The frontend loads no
 * third-party origins and no inline scripts; Radix scroll locking and xterm
 * insert runtime <style> elements, so styles alone allow 'unsafe-inline'.
 * HSTS belongs to the TLS-terminating edge, which knows the real scheme and
 * whether sibling subdomains are HTTPS.
 */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: false,
  });
}
