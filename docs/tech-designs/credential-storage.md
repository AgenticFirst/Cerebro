# Secure Credential Storage

## Problem Statement

Cerebro needs to store API keys for cloud model providers (Anthropic, OpenAI, Google) so they persist across app restarts. Keys must be encrypted at rest using OS-native facilities and never exposed to the renderer process.

## Security Disclaimer

> **This is a V0 implementation.** This credential storage system has not undergone a formal, independent security audit. While we follow established best practices — OS-native encryption via Electron `safeStorage`, process-level trust boundaries, and no plaintext secrets on disk — we do not claim this to be a hardened or production-grade secrets management solution.
>
> If you discover a vulnerability, please contact the maintainers directly.

## Architecture Overview

```
Renderer (React)                Main Process (Node)              Disk
+-----------------+    IPC     +-------------------+
| credentials.set |  -------> | ipcMain.handle    |
| credentials.has |  <------- | setCredential()   | ---> credentials.enc
| credentials.del |           | hasCredential()   |      (encrypted blobs)
| credentials.list|           | listCredentials() |
+-----------------+           | getCredential()   | <--- (main-only decrypt)
                              +-------------------+
       NEVER gets                     |
       raw key values         safeStorage API
                              (macOS Keychain / Windows DPAPI)
```

## Technology Choice: Electron `safeStorage`

| Option | Pros | Cons |
|--------|------|------|
| **`safeStorage` (chosen)** | Zero deps, ships with Electron, OS-native encryption | Linux needs libsecret |
| `keytar` | Direct keychain access | Native module, needs rebuild per Electron version |
| Manual AES encryption | Full control | Must manage key storage ourselves |

`safeStorage` is the clear winner: zero native dependencies, maintained by Electron team, and delegates to the OS keychain on macOS (Keychain Services) and Windows (DPAPI).

## Security Model

### Trust Boundaries

1. **Renderer process** (untrusted): Can set, check existence, delete, and list credentials. **Cannot read raw values.**
2. **Main process** (trusted): Can decrypt credentials transiently for injection into backend requests.
3. **Disk** (`credentials.enc`): Contains only base64-encoded encrypted blobs. Useless without the OS user session.

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Renderer compromise (XSS) | No `getCredential` IPC channel exposed |
| File theft (`credentials.enc`) | Values encrypted via OS keychain; undecryptable without user session |
| Process memory dump | Keys decrypted transiently, not held in long-lived variables |
| Corrupt/tampered file | Graceful recovery: malformed JSON resets to empty store |

## API Reference

### Credential Store (`src/credentials.ts`)

```typescript
initCredentialStore(): void
setCredential(service: string, key: string, value: string, label?: string): CredentialResult<void>
getCredential(service: string, key: string): string | null  // main-process only
hasCredential(service: string, key: string): boolean
deleteCredential(service: string, key: string): CredentialResult<void>
clearCredentials(service?: string): CredentialResult<void>
listCredentials(service?: string): CredentialInfo[]
```

### IPC Channels

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `credential:set` | renderer -> main | `{ service, key, value, label? }` | `CredentialResult<void>` |
| `credential:has` | renderer -> main | `{ service, key }` | `boolean` |
| `credential:delete` | renderer -> main | `{ service, key }` | `CredentialResult<void>` |
| `credential:clear` | renderer -> main | `{ service? }` | `CredentialResult<void>` |
| `credential:list` | renderer -> main | `{ service? }` | `CredentialInfo[]` |

## File Format (`credentials.enc`)

```json
{
  "anthropic:api_key": {
    "encrypted": "<base64-encoded buffer>",
    "label": "Anthropic API Key",
    "updatedAt": "2026-02-28T12:00:00.000Z"
  }
}
```

- **Composite key**: `{service}:{key}` (e.g., `anthropic:api_key`)
- **`encrypted`**: Base64-encoded output of `safeStorage.encryptString()`
- **`label`**: Optional human-readable description
- **`updatedAt`**: ISO 8601 timestamp of last update

## Platform Behavior

| Platform | Encryption Backend | Notes |
|----------|-------------------|-------|
| macOS | Keychain Services | Transparent, no user prompt |
| Windows | DPAPI | Tied to Windows user account |
| Linux | libsecret (GNOME Keyring / KWallet) | Requires `gnome-keyring` or `kwallet` |

## Error Handling and Recovery

- **Encryption unavailable** (`safeStorage.isEncryptionAvailable() === false`): Returns error result; UI shows failure message.
- **Corrupted file**: On JSON parse failure, resets store to `{}` and continues.
- **Missing file**: Created on first write.
- **Atomic writes**: Write to `.tmp` then `fs.renameSync` to prevent partial writes on crash.

## Future Considerations

- **Credential injection to backend**: Main process decrypts and injects API keys into proxied LLM requests (never sent to renderer).
- **OAuth token storage**: Same store can hold OAuth access/refresh tokens.
- **Key rotation**: `setCredential` overwrites in place; old encrypted blob is discarded.
