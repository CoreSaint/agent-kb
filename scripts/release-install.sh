#!/usr/bin/env sh
set -eu

usage() {
  echo "usage: ./install.sh <new-destination>" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

destination=$1
if [ -z "$destination" ]; then
  usage
  exit 2
fi
if [ -z "${HOME:-}" ]; then
  echo "HOME is required" >&2
  exit 1
fi
if [ -e "$destination" ] || [ -L "$destination" ]; then
  echo "destination already exists: $destination" >&2
  exit 1
fi

node -e 'const major = Number(process.versions.node.split(".")[0]); if (!Number.isInteger(major) || major < 26) { console.error(`Node.js 26 or newer is required; found ${process.versions.node}`); process.exit(1); }'

script_path=$0
case "$script_path" in
  */*) ;;
  *) script_path=./$script_path ;;
esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd -P)
release_root=$script_dir
vault_source=$release_root/vault
tool_source=$release_root/tool
skill_source=$tool_source/skills/agent-memory-vault/SKILL.md
version_file=$release_root/VERSION

for required in "$vault_source" "$tool_source" "$tool_source/bin/kb" "$skill_source" "$version_file"; do
  if [ ! -e "$required" ]; then
    echo "release artifact is incomplete: $required" >&2
    exit 1
  fi
done
if [ ! -x "$tool_source/bin/kb" ]; then
  echo "release artifact kb launcher is not executable: $tool_source/bin/kb" >&2
  exit 1
fi

parent=$(dirname -- "$destination")
if [ ! -d "$parent" ]; then
  echo "destination parent does not exist: $parent" >&2
  exit 1
fi

skill_target=$HOME/.agents/skills/agent-memory-vault/SKILL.md
if [ -L "$skill_target" ] && [ ! -e "$skill_target" ]; then
  echo "skill conflict: $skill_target is a dangling symlink; refusing to overwrite" >&2
  exit 1
fi
if [ -e "$skill_target" ]; then
  if ! cmp -s "$skill_source" "$skill_target"; then
    echo "skill conflict: $skill_target differs; refusing to overwrite" >&2
    exit 1
  fi
  node -e 'const fs = require("node:fs"); const mode = fs.statSync(process.argv[1]).mode & 0o777; if (mode !== 0o600) { console.error(`skill mode is not 0600: ${process.argv[1]}`); process.exit(1); }' "$skill_target"
fi
for directory in "$HOME/.agents" "$HOME/.agents/skills" "$HOME/.agents/skills/agent-memory-vault"; do
  if [ -L "$directory" ] && [ ! -e "$directory" ]; then
    echo "skill path component is a dangling symlink: $directory" >&2
    exit 1
  fi
  if [ -e "$directory" ] && [ ! -d "$directory" ]; then
    echo "skill path component is not a directory: $directory" >&2
    exit 1
  fi
done


umask 077
cp -pR "$vault_source" "$destination"
mkdir -m 700 "$destination/.agent-kb"
cp -pR "$tool_source" "$destination/.agent-kb/tool"

for directory in "$HOME/.agents" "$HOME/.agents/skills" "$HOME/.agents/skills/agent-memory-vault"; do
  if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then
    mkdir -m 700 "$directory"
  fi
  if [ ! -d "$directory" ]; then
    echo "skill path component is not a directory: $directory" >&2
    exit 1
  fi
done

if [ ! -e "$skill_target" ]; then
  cp "$skill_source" "$skill_target"
  chmod 600 "$skill_target"
fi

status_file=$(mktemp "${TMPDIR:-/tmp}/agent-kb-install-status.XXXXXX")
version_status_file=$(mktemp "${TMPDIR:-/tmp}/agent-kb-install-version.XXXXXX")
contract_status_file=$(mktemp "${TMPDIR:-/tmp}/agent-kb-install-contract.XXXXXX")
trap 'rm -f "$status_file" "$version_status_file" "$contract_status_file"' EXIT HUP INT TERM
(
  cd "$destination"
  .agent-kb/tool/bin/kb version --json >"$version_status_file"
  .agent-kb/tool/bin/kb contract --json >"$contract_status_file"
  ./kb init --json >/dev/null
  ./kb status --json >"$status_file"
)

node -e '
const fs = require("node:fs");
const path = require("node:path");
const [destination, skillSource, skillTarget, versionFile, versionStatusFile, contractStatusFile, statusFile] = process.argv.slice(1);
const expectedVersion = fs.readFileSync(versionFile, "utf8").trim();
const destinationReal = fs.realpathSync(destination);
const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
const version = JSON.parse(fs.readFileSync(versionStatusFile, "utf8"));
const contract = JSON.parse(fs.readFileSync(contractStatusFile, "utf8"));
function fail(message) { console.error(message); process.exit(1); }
function mode(file) { return fs.statSync(file).mode & 0o777; }
if (!version.ok || version.contract_version !== "1" || version.command !== "version" || version.data.version !== expectedVersion || version.data.contract_version !== "1") fail("kb version envelope verification failed");
if (!contract.ok || contract.contract_version !== "1" || contract.command !== "contract" || contract.data.contract_version !== "1") fail("kb contract envelope verification failed");
const database = path.join(destinationReal, ".agent-kb", "kb.sqlite");
if (!status.ok || status.contract_version !== "1" || status.command !== "status") fail("kb status envelope verification failed");
if (status.data.path !== database || fs.realpathSync(status.data.path) !== database) fail("installed kb status did not point at the destination database real path");
if (status.data.schemaVersion !== 2) fail("installed database schema version is not 2");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(status.data.authorityDomainId)) fail("installed database authority domain is invalid");
if (mode(path.join(destinationReal, ".agent-kb")) !== 0o700) fail(".agent-kb mode is not 0700");
if (mode(database) !== 0o600) fail("database mode is not 0600");
if (mode(skillTarget) !== 0o600) fail("installed skill mode is not 0600");
if (!fs.readFileSync(skillSource).equals(fs.readFileSync(skillTarget))) fail("installed skill differs from release skill");
fs.rmSync(path.join(destinationReal, "INIT.md"), { force: true });
const report = {
  ok: true,
  version: expectedVersion,
  destination: destinationReal,
  tool: path.join(destinationReal, ".agent-kb", "tool"),
  database,
  skill: skillTarget,
  authorityDomainId: status.data.authorityDomainId,
};
console.log(JSON.stringify(report, null, 2));
' "$destination" "$skill_source" "$skill_target" "$version_file" "$version_status_file" "$contract_status_file" "$status_file"

rm -f "$status_file" "$version_status_file" "$contract_status_file"
trap - EXIT HUP INT TERM
