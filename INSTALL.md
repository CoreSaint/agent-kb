# Install the portable agent-memory vault

These instructions are for a shell-capable agent asked to install a new vault from a versioned `agent-kb` release archive. They install the copyable `vault/` scaffold and a vault-local copy of the `agent-kb` tool, not a repository development checkout.

## Inputs and safety

1. Obtain an explicit destination from the user. If none was given, ask before writing.
2. The destination must not already exist. Do not merge into or overwrite an existing folder, contract vault, skill, database, or checkout.
3. Do not use elevation, alter credentials, modify global PATH, or make unrelated system changes.
4. Require a downloaded release archive, Node.js 26 or newer, and permission to write the destination. The release installer verifies the remaining prerequisites without network access.

## Build a release archive from this repository

Repository maintainers can create the host-native archive with:

```sh
npm run build:release
```

The generated archive is ignored under `release/` and is named `agent-kb-<version>-<platform>-<arch>.tar.gz`, for example `agent-kb-1.0.0-linux-x64.tar.gz`. It contains one top-level directory with:

- `install.sh`: the single install and initialization entry point;
- `vault/`: the empty vault scaffold;
- `tool/`: the local agent-KB CLI runtime, source, documentation, and reusable skill;
- `VERSION`: the packaged tool version.

The archive intentionally excludes `.git`, `node_modules`, generated release output, `.agent-kb`, SQLite files, WAL/SHM files, logs, and other runtime state.

## Bootstrap from the archive

Extract the archive in a disposable location, set `destination` to the user-approved path, and run:

```sh
set -eu
umask 077
destination=./vault              # replace only with the user-approved destination
test ! -e "$destination" || {
  echo "destination already exists: $destination" >&2
  exit 1
}
tar -xzf agent-kb-<version>-<platform>-<arch>.tar.gz
./agent-kb-<version>-<platform>-<arch>/install.sh "$destination"
```

The installer copies the scaffold, places the packaged tool at `<destination>/.agent-kb/tool`, safely installs or validates the reusable skill at `$HOME/.agents/skills/agent-memory-vault/SKILL.md`, initializes `<destination>/.agent-kb/kb.sqlite`, verifies `./kb status --json`, checks that the database path is vault-local, removes `INIT.md` after successful verification, and reports destination, tool, database, skill, authority domain, and version.

If a step fails, stop, report the exact failure and any temporary or partially copied path left behind, and do not pretend installation succeeded. The installer refuses an existing destination and refuses to overwrite a differing reusable skill. It does not use sudo, mutate global PATH, publish anything, or contact the network.

## Agent-readable fallback

`vault/INIT.md` remains in the archive as an audit guide and fallback for agents inspecting a copied scaffold. The release installer performs those checks automatically and removes `INIT.md` only after verification succeeds.

Do not initialize the repository's source `vault/` directory in place. It is a template and must remain clean for future copies.
