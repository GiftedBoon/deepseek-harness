# Agent Note: Optional browser password login

Status: implemented

English | [中文](2026-09-01-browser-password-login.zh.md)

## Problem

The Web application authenticates a browser by exchanging a process launch token for a 30-day authority-bound cookie. That exchange works for an operator who can read the startup URL, but an unattended service deliberately suppresses the URL to keep the token out of journals. A user opening the service from another device then has no ordinary sign-in path, even when the deployment already stores an access password through the credential service.

## Decision

`dsh-client-connection` accepts an optional `passwordLogin` configuration with one username and a credential reference. Connection activation resolves the reference and fails when its value is missing or empty. The exact `/login` route is registered only when this configuration exists. It applies the same Host, Origin, and Fetch-Metadata trust checks as `/api`, so form login does not authorize an undeclared authority or a cross-site browser request.

The login page selects English or Chinese copy from `Accept-Language` and contains no client script. `GET` and `HEAD` serve the page, while `POST` accepts only `application/x-www-form-urlencoded` bodies up to 8 KiB. A failed attempt returns the same 401 response for an unknown username, wrong password, missing field, unavailable rotated credential, or invalid authority. Password comparison uses `timingSafeEqual` after an equal-length check. A successful attempt issues the existing signed, authority-bound browser cookie and redirects to `/`; it does not create another session format or credential store.

The password reference is resolved for every attempt, so credential rotation applies without reloading Connection. Existing cookies remain valid until their normal expiry or global signing-secret revocation. When password login is configured, an unauthenticated `GET` or `HEAD` index request redirects to `/login`; the process launch-token exchange remains valid as an operator recovery path. The [browser launch-token authentication decision](../architecture/2026-08-24-browser-token-authentication.md) continues to own cookie contents, lifetime, revocation, and complete Host API authorization.

## Alternatives considered

**Require operators to copy each process launch token to every device.** Rejected because an unattended service suppresses that credential from logs, and process restarts replace it. The password path preserves the existing persistent cookie after one ordinary sign-in.

**Put HTTP Basic Authentication only in a reverse proxy.** Rejected as the product mechanism because it creates a second browser credential layer that cannot issue or reuse the Host API cookie. A deployment may still add proxy controls such as TLS, network restriction, and attempt throttling around the application route.

**Store a password hash in Connection configuration.** Rejected because configuration files and generated dumps are not credential stores, and rotation would require editing the profile. A credential reference keeps the value in the deployment's existing secret path and out of the Cordis configuration.

**Invalidate every cookie when the password changes.** Rejected because the password authenticates a new browser while the signing secret authenticates an established session. Operators retain the existing global revocation mechanism: delete the browser-session credential record and restart the process.

## Consequences

An unattended or proxied deployment can present a stable login page while retaining one browser-session format and one authorization check for the complete Host API. Deployments that omit `passwordLogin` retain launch-token behavior and do not register `/login`.

The built-in form does not provide TLS, account recovery, logout, multi-user identity, or attempt throttling. A network deployment must restrict reachability, protect plaintext credentials and cookies with TLS when the network is not trusted, and apply suitable request-rate controls at its reverse proxy. The configured username is displayable page content rather than a secret.

## Testing

Connection tests cover optional route registration, missing and empty credentials, English and Chinese rendering, HEAD behavior, wrong credentials, password rotation and removal, existing-cookie redirection, unsupported methods and media types, both declared-length and streamed body limits, cookie issuance, and the unchanged launch-token path. The real HTTP test continues to cover uniform Host API authentication through Node's server implementation.
