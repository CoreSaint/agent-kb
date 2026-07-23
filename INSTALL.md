# Install the portable agent-memory vault

These Linux-only V1 instructions are for a shell-capable agent asked to install a fresh vault from either the Git repository URL or a versioned `agent-kb` Linux release archive. Both paths install the copyable `vault/` scaffold and a vault-local copy of the `agent-kb` tool, not a repository development checkout.

## Inputs and safety

1. Obtain an explicit destination from the user. If none was given, ask before writing.
2. The destination must not already exist. Treat dangling symlinks as existing. Do not merge into or overwrite an existing folder, contract vault, skill, database, or checkout.
3. Do not use elevation, alter credentials, modify global PATH, or make unrelated system changes.
4. Require Linux and Node.js 26 or newer. For repository-URL installs, also require Git, network access to the requested repository URL, and permission to write the destination. For archive installs, require a downloaded Linux release archive and permission to write the destination. The release installer verifies the remaining prerequisites without network access.

## Install from the repository URL

For the prompt:

> Install the portable agent-memory vault from `https://github.com/CoreSaint/agent-kb` into `<destination>`. Follow `INSTALL.md`; do not use sudo or overwrite existing files.

set `repository_url` and `destination` to the user-approved values and run the equivalent of:

```sh
set -eu
umask 077
repository_url=https://github.com/CoreSaint/agent-kb
destination=./vault              # replace only with the user-approved destination
test ! -e "$destination" && test ! -L "$destination" || {
  echo "destination already exists: $destination" >&2
  exit 1
}
host_os=$(uname -s 2>/dev/null) || {
  echo "unable to determine host operating system; Linux is required" >&2
  exit 1
}
test "$host_os" = Linux || {
  echo "unsupported host operating system: $host_os; Linux is required" >&2
  exit 1
}
git --version >/dev/null
node -e 'const major = Number(process.versions.node.split(".")[0]); if (!Number.isInteger(major) || major < 26) process.exit(1)'
bootstrap_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-kb-bootstrap.XXXXXX")
printf 'bootstrap_root=%s\n' "$bootstrap_root" >&2
git clone --depth 1 "$repository_url" "$bootstrap_root/agent-kb"
(
  cd "$bootstrap_root/agent-kb"
  npm run build:release
)
archive=$(find "$bootstrap_root/agent-kb/release" -maxdepth 1 -type f -name 'agent-kb-*.tar.gz' -print)
test "$(printf '%s\n' "$archive" | sed '/^$/d' | wc -l)" -eq 1
mkdir -m 700 "$bootstrap_root/extract"
tar -xzf "$archive" -C "$bootstrap_root/extract"
release_root=$(find "$bootstrap_root/extract" -mindepth 1 -maxdepth 1 -type d -print)
test "$(printf '%s\n' "$release_root" | sed '/^$/d' | wc -l)" -eq 1
"$release_root/install.sh" "$destination"
rm -rf "$bootstrap_root"
```

If any step before the final `rm -rf "$bootstrap_root"` fails, stop and report the exact command, stderr/stdout, destination, and retained `bootstrap_root` path for inspection. Do not retry by merging into a partial destination. Remove the temporary clone/build/extract directory only after `install.sh` reports success.

The source-install path intentionally reuses `npm run build:release` and the packaged `install.sh`; it is not a second installer implementation.

## Build a release archive from this repository

Repository maintainers can create the host-native archive with:

```sh
npm run build:release
```

The generated archive is ignored under `release/` and is named `agent-kb-<version>-linux-<arch>.tar.gz`, for example `agent-kb-1.0.0-linux-x64.tar.gz`. The build fails clearly on non-Linux hosts. It contains one top-level directory with:

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
test ! -e "$destination" && test ! -L "$destination" || {
  echo "destination already exists: $destination" >&2
  exit 1
}
tar -xzf agent-kb-<version>-linux-<arch>.tar.gz
./agent-kb-<version>-linux-<arch>/install.sh "$destination"
```

The Linux-only installer rejects unsupported hosts, copies the scaffold, places the packaged tool at `<destination>/.agent-kb/tool`, safely installs or validates the reusable skill at `$HOME/.agents/skills/agent-memory-vault/SKILL.md`, initializes `<destination>/.agent-kb/kb.sqlite`, verifies `./kb status --json`, checks that the database path is vault-local, removes `INIT.md` after successful verification, and reports destination, tool, database, skill, authority domain, and version.

If a step fails, stop, report the exact failure and any temporary or partially copied path left behind, and do not pretend installation succeeded. The installer refuses an existing destination and refuses to overwrite a differing reusable skill. It does not use sudo, mutate global PATH, publish anything, or contact the network.

## Agent-readable fallback

`vault/INIT.md` remains in the archive as an audit guide and fallback for agents inspecting a copied scaffold. The release installer performs those checks automatically and removes `INIT.md` only after verification succeeds.

Do not initialize the repository's source `vault/` directory in place. It is a template and must remain clean for future copies.
