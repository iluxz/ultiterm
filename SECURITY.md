# security policy

## supported versions

ultiterm is early-stage. right now, only the **latest version on `main`** is supported for security fixes.

| version | supported |
|---|---|
| `main` / latest | ✅ |
| older releases | ❌ |

## reporting a vulnerability

if you find a security issue, **please do not open a public issue or PR**.

instead, report it privately:

1. go to the repo’s **Security** tab
2. click **Report a vulnerability** (GitHub Private Vulnerability Reporting)
3. include as much detail as possible

### what to include

- what the issue is and why it matters
- affected files/components (frontend, tauri command, conpty/session, config, etc.)
- steps to reproduce / proof of concept
- impact (what an attacker could do)
- your suggested fix, if you have one

## what to expect

- i’ll try to acknowledge reports asap
- if it’s valid, we’ll work on a fix and coordinate disclosure
- please give a reasonable window to patch before posting publicly

## scope notes

stuff especially worth reporting:

- command injection / unsafe process spawning
- tauri command privilege issues / unsafe IPC exposure
- path traversal / arbitrary file read-write via config/imports
- malicious config/plugin/theme payloads (once those systems exist)
- sandbox/csp escapes or dangerous webview behavior

thanks for helping keep ultiterm safe.
