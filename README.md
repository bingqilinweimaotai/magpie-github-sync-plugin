# Magpie GitHub sync plugin

Keep Magpie's encrypted setup in a GitHub repository without patching Magpie.

This is an unofficial plugin. It loads through Magpie's Bun plugin host and
provides a WebDAV bridge bound only to `127.0.0.1`. Magpie's existing sync
engine still owns encryption, merging, restore, undo, and usage sharing.
The bridge translates file operations to GitHub's Contents API.

## Install

In **Settings > Plugins > Discover > Unofficial plugins · GitHub**, look for
`magpie-github-sync-plugin` and install it. Its repository carries the
`magpie-plugin` GitHub topic. Discovery depends on GitHub search indexing and
Magpie's cache: newer versions refresh about every ten minutes; older versions
may keep a six-hour cache.

You can install immediately from the repository instead:

```sh
magpie plugin add github:bingqilinweimaotai/magpie-github-sync-plugin
```

Open **Settings > Plugins** so Magpie loads the plugin. Keep the app, `magpie web`,
or the gateway running. The plugin needs Magpie's Bun host; there is no
separate Node installation, build step, npm publication, or install script.

## Bind a repository

1. Open **http://127.0.0.1:3437/** while Magpie is running.
2. Enter an existing GitHub repository (`owner/repo`), optional branch and
   folder, and a token with **Contents: read and write** for that repository.
   A private backup repository is recommended. Save the configuration.
3. The page gives you a local **Address**, **User name**, and **Local password**.
   Enter them under **Settings > Sync > WebDAV** in Magpie.
4. Choose an encryption passphrase, different from both the GitHub token
   and the local password. Select which parts to sync and save.

The bridge checks repository and branch access before saving. This check
does not prove that a branch protection rule will permit writes. Any later
GitHub error is shown on the setup page.

The backup is `<folder>/magpie/magpie.magpie-backup`, matching the layout of
the proposed native GitHub backend. Optional encrypted usage and quota files
are under `<folder>/magpie/usage/`. Each changed file creates a commit.
An unchanged backup does not create a commit.

An empty repository is initialized on its default branch by the first backup.
Other selected branches must already exist.

## Restore on another computer

Install this plugin there, bind the **same repository, branch and folder**,
then configure WebDAV using that computer's generated bridge credentials.
Use the **same encryption passphrase and inclusion switches** in Magpie.
Click **Restore**. Magpie retains the displaced local setup for **Undo**.
Automatic and manual sync work through Magpie's existing controls.

The local password can differ between computers. The plugin never receives
the encryption passphrase. Magpie's own backup rules determine which
providers, keys, settings, profiles, agent models and library data are portable.
This does not clone a working directory or copy all machine-local files.

## Compatibility and lifecycle

- This is a bridge, not a new entry in Magpie's native backend selector.
  The Sync page identifies it as WebDAV. The Plugins page may label it as
  a provider because it has no separate background-service category;
  this plugin adds no models or fake provider account.
- Plugin initialization starts the bridge. The native sync API does not
  initialize plugins itself; open Plugins first if a CLI-only sync reports
  connection refused.
- Multiple Magpie/CLI hosts for the same profile share the bridge.
  The remaining host takes over within about two seconds if its owner exits.
  A sync during that gap may need a retry.
- Disabling or removing the plugin closes its listener within about two
  seconds; already active operations finish. Existing native sync settings
  remain, so switch off WebDAV sync too if it is no longer wanted.
- A different profile needs another port. Set it with
  `magpie plugin options magpie-github-sync-plugin '{"port":3438}'`, then use
  `http://127.0.0.1:3438/`. In PowerShell, pass JSON as a single quoted argument.
- Changing repository, branch or folder changes the generated WebDAV
  address. Update the native Sync form to the new address. Old addresses
  fail instead of silently accessing another repository.
- Existing WebDAV/S3 switching works as Magpie implements it. This plugin
  does not add the native PR's three-backend configuration selector.

## Credentials and errors

Configuration and a separate local bridge password live in
`<magpie-config>/github-sync-plugin/state.json`. On POSIX this file is mode
`0600`; on Windows it inherits the user's configuration directory ACLs.
The file is not part of the encrypted remote backup. Configure credentials
separately on each computer.

The token is sent only to `https://api.github.com`; redirects are refused.
Leaving the token blank reuses it only for the same repository. Existing
tokens never return to the setup form. Local configuration requires a
same-origin CSRF token; DAV access requires the local bridge password.

Conditional writes use blob SHAs and return a precondition failure when
another computer changes the backup, so Magpie can read and merge again.
Missing repositories and branches, malformed metadata, failed reads and
authentication failures are not treated as missing backups. Rate limits
are passed back to Magpie's sync backoff.

The bridge accepts only sealed Magpie version 1 backup and usage files,
up to 64 MiB each. Usage listings reaching GitHub's 1,000-entry limit fail
explicitly. Repository history retains previous encrypted versions.

## Development

No runtime dependencies:

```sh
npm test
```

Tests use temporary profiles, real local HTTP requests and GitHub API
fixtures. They never read or write the user's Magpie configuration.
The CI matrix runs the suite on Windows, Linux and macOS.

Optional integration tests run when `BUN_BIN` and `MAGPIE_HOST` point to
Bun and Magpie's `internal/plugin/host.js`, and when `MAGPIE_BIN` points
to a Magpie executable. They verify host takeover and disable, then native
encrypted upload, unchanged sync, fresh-profile restore and undo against
an in-memory GitHub fixture. Both profiles are isolated from user files.

Magpie integration references:

- [Plugin guide](https://usemagpie.ai/docs/plugins)
- [Plugin host](https://github.com/yetone/magpie/blob/main/internal/plugin/host.js)
- [GitHub discovery](https://github.com/yetone/magpie/blob/main/internal/plugin/github.go)
- [Native WebDAV sync](https://github.com/yetone/magpie/blob/main/internal/davsync/dav.go)
