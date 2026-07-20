# Client update: WordPress-familiar, custom app

## Short paragraph to send

We did not connect this system to WordPress. PerformanceXtra is a custom web app, but we implemented a WordPress-familiar structure so your team can use it immediately: a clear Users area, role-based access, a dedicated account/security area, and CMS-style content and appearance controls. Your requested Users and Security changes are now included directly in this app.

## WordPress-familiar features checklist

Use this list when confirming delivery with stakeholders:

- [x] Top-level Users area for account management
- [x] Role-based access (super admin vs athlete)
- [x] Dedicated account/security actions (password/passcode/session handling)
- [x] CMS-style Content management (activities + taxonomy)
- [x] CMS-style Appearance management (branding, navigation, page builder)
- [x] Server-enforced permissions (not client-side only)
- [x] No WordPress dependency, plugin surface, or wp-admin requirement

## Security summary to send

PerformanceXtra security is handled inside the app stack, not by WordPress plugins.

- Access is role-based and enforced on the server (super admin and athlete permissions are separated).
- Sessions are signed and stored in secure HTTP-only cookies.
- Passwords/passcodes are stored as one-way hashes, not plaintext.
- Lost passcodes are reset-only (not recoverable), and resets can invalidate old sessions.
- Login attempts are rate-limited to reduce credential-guessing attacks.
- The app has no WordPress plugin or wp-admin attack surface.

## Optional security one-liner

Security is app-native: server-enforced roles, secure signed sessions, hashed credentials, rate limits, and no WordPress/plugin attack surface.

## Optional one-line version

Not WordPress-connected; WordPress-familiar by design, with your requested Users and Security workflow implemented in-app.
