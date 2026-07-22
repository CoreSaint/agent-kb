# Install the portable agent-memory vault

These instructions are for a shell-capable agent asked to install a new vault from this repository. They install the copyable `vault/` scaffold, not the repository development checkout itself.

## Inputs and safety

1. Obtain an explicit destination from the user. If none was given, ask before writing.
2. The destination must not already exist. Do not merge into or overwrite an existing folder, contract vault, skill, database, or checkout.
3. Do not use elevation, alter credentials, modify global PATH, or make unrelated system changes.
4. Require network access, Git, and permission to write the destination. `INIT.md` will verify the remaining prerequisites.

## Bootstrap

From the directory that should contain the new vault, set `destination` to the user-approved path and run the equivalent of:

```sh
set -eu
umask 077
destination=./vault              # replace only with the user-approved destination
test ! -e "$destination" || {
  echo "destination already exists: $destination" >&2
  exit 1
}
bootstrap_root=$(mktemp -d "${TMPDIR:-/tmp}/agent-kb-bootstrap.XXXXXX")
git clone --depth 1 https://github.com/CoreSaint/agent-kb.git "$bootstrap_root/agent-kb"
cp -a "$bootstrap_root/agent-kb/vault" "$destination"
mkdir -m 700 "$destination/.agent-kb"
mv "$bootstrap_root/agent-kb" "$destination/.agent-kb/tool"
rmdir "$bootstrap_root"
cd "$destination"
```

Preserve dotfiles and the executable mode of `kb`; do not replace `cp -a` with a copy that omits them. If a step fails, stop, report the exact failure and any temporary path left behind, and do not pretend installation succeeded.

## Initialize

Inside the copied destination:

1. Read `AGENTS.md`.
2. Process `INIT.md` completely.
3. Let `INIT.md` verify the supplied `.agent-kb/tool`, install or safely validate the reusable skill, initialize `.agent-kb/kb.sqlite`, and check paths and permissions.
4. Remove `INIT.md` only when its complete verification succeeds.
5. Report the destination, tool version, database path, and skill path.

Do not initialize the repository's source `vault/` directory in place. It is a template and must remain clean for future copies.
