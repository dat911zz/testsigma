/**
 * In-process mini-IdP OIDC for test and dev.
 *
 * WHY NOT USE REAL KEYCLOAK HERE: the sandbox/CI runner does not guarantee a docker
 * daemon (spike M1: /var/run/docker.sock does not exist). WHY NOT oauth2-mock-server:
 * it can't emit a broken id_token on demand, and the negative cases are exactly what's worth testing.
 *
 * The real IdP in prod is self-hosted Keycloak (decision 2026-08-28). Everything this mini-IdP
 * emits is standard OIDC: discovery, JWKS, authorization code + PKCE S256, RS256.
 */
import { createServer, type Server } from "node:http";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
} from "jose";

export type MockIdp = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly close: () => Promise<void>;
};

type Pending = {
  nonce: string | null;
  challenge: string | null;
  mode: string;
  email: string;
  /**
   * `tk_email_verified`: "true" (default) | "false" | "absent".
   * "absent" = the IdP does NOT emit the `email_verified` claim (Keycloak can turn off the email scope).
   * This is the switch that lets us test the rule "an unverified email is not linked to an
   * existing account" — without it, there'd be no way to verify this from outside.
   */
  emailVerified: string;
  groups: string[];
  sub: string;
};

export async function startMockIdp(
  opts: { readonly clientId?: string; readonly clientSecret?: string } = {},
): Promise<MockIdp> {
  const clientId = opts.clientId ?? "testkite-core";
  const clientSecret = opts.clientSecret ?? "s3cret";
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = await calculateJwkThumbprint(jwk);
  jwk.alg = "RS256";
  jwk.use = "sig";
  // A key NOT present in the JWKS — used for the unknown_kid case.
  const rogue = await generateKeyPair("RS256", { extractable: true });

  const codes = new Map<string, Pending>();
  let issuer = "";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", issuer);
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (url.pathname === "/.well-known/openid-configuration") {
        json(200, {
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile", "email", "groups"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        });
        return;
      }
      if (url.pathname === "/jwks") {
        json(200, { keys: [jwk] });
        return;
      }

      if (url.pathname === "/auth") {
        const code = randomUUID();
        codes.set(code, {
          nonce: url.searchParams.get("nonce"),
          challenge: url.searchParams.get("code_challenge"),
          mode: url.searchParams.get("tk_mode") ?? "ok",
          email: url.searchParams.get("tk_email") ?? "oidc@acme.test",
          emailVerified: url.searchParams.get("tk_email_verified") ?? "true",
          groups: (url.searchParams.get("tk_groups") ?? "qa-authors").split(","),
          sub: url.searchParams.get("tk_sub") ?? "kc-user-1",
        });
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? `${issuer}/cb`);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: redirect.toString() });
        res.end();
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const raw = await new Promise<string>((resolve) => {
          let b = "";
          req.on("data", (c: Buffer) => {
            b += c.toString();
          });
          req.on("end", () => resolve(b));
        });
        const form = new URLSearchParams(raw);
        const rec = codes.get(form.get("code") ?? "");
        if (rec === undefined) {
          json(400, { error: "invalid_grant" });
          return;
        }
        codes.delete(form.get("code") ?? "");
        if (rec.challenge !== null) {
          const computed = createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url");
          if (computed !== rec.challenge) {
            json(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
            return;
          }
        }
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          email: rec.email,
          groups: rec.groups,
          nonce: rec.nonce ?? undefined,
          ...(rec.emailVerified === "absent"
            ? {}
            : { email_verified: rec.emailVerified === "true" }),
        };
        const sign = (
          iss: string,
          aud: string,
          exp: number,
          kid: string,
          key: CryptoKey,
        ): Promise<string> =>
          new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256", kid })
            .setIssuer(iss)
            .setSubject(rec.sub)
            .setAudience(aud)
            .setIssuedAt(now)
            .setExpirationTime(exp)
            .sign(key);
        const kid = String(jwk.kid);
        const idToken =
          rec.mode === "expired"
            ? await sign(issuer, clientId, now - 60, kid, privateKey)
            : rec.mode === "wrong_aud"
              ? await sign(issuer, "other-aud", now + 300, kid, privateKey)
              : rec.mode === "wrong_iss"
                ? await sign("https://evil.example", clientId, now + 300, kid, privateKey)
                : rec.mode === "unknown_kid"
                  ? await sign(issuer, clientId, now + 300, "kid-does-not-exist", rogue.privateKey)
                  : await sign(issuer, clientId, now + 300, kid, privateKey);
        json(200, {
          access_token: randomBytes(24).toString("base64url"),
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
          scope: "openid email profile groups",
        });
        return;
      }
      json(404, { error: "not_found" });
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
