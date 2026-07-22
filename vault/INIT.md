# Initialize this vault

Complete every step before normal work. Keep this file if any step fails and report the exact blocker. Remove it only after all checks succeed.

1. Work from this directory. Confirm `CONTRACT.md`, `MAP.md`, `AGENTS.md`, and `kb` are present.
2. Check `git --version` and Node.js major version with `node -p "process.versions.node"`. Node.js must be 26 or newer.
   - If Git or Node.js is missing, you may use host-appropriate **user-space** tooling.
   - Do not use elevation, change credentials, alter global PATH, or make destructive system changes without explicit permission.
3. Install or verify the local tool:

   ```sh
   umask 077
   mkdir -p .agent-kb
   chmod 700 .agent-kb
   if [ ! -e .agent-kb/tool ]; then
     git clone https://github.com/CoreSaint/agent-kb.git .agent-kb/tool
   fi
   test -x .agent-kb/tool/bin/kb
   .agent-kb/tool/bin/kb version --json
   ```

   Accept an existing checkout only when the version command returns a successful JSON envelope with `contract_version` equal to `1`. Do not overwrite an incompatible or unexpected directory; stop and report it.
4. Install or verify the reusable agent skill:

   ```sh
   skill_source=.agent-kb/tool/skills/agent-memory-vault/SKILL.md
   skill_target="$HOME/.agents/skills/agent-memory-vault/SKILL.md"
   test -f "$skill_source"
   for directory in "$HOME/.agents" "$HOME/.agents/skills" "$HOME/.agents/skills/agent-memory-vault"; do
     if [ ! -e "$directory" ]; then
       mkdir -m 700 "$directory"
     fi
     test -d "$directory"
   done
   if [ -e "$skill_target" ]; then
     if ! cmp -s "$skill_source" "$skill_target"; then
       echo "skill conflict: $skill_target differs; refusing to overwrite" >&2
       exit 1
     fi
   else
     cp "$skill_source" "$skill_target"
     chmod 600 "$skill_target"
   fi
   test -f "$skill_target"
   cmp -s "$skill_source" "$skill_target"
   node -e 'const fs=require("node:fs"); const s=fs.readFileSync(process.argv[1],"utf8"); if (/(?:\/home\/|\/Users\/|\/var\/home\/|[A-Za-z]:\\)/.test(s)) process.exit(1)' "$skill_target"
   ```

   An identical existing skill is valid. Never overwrite a different file; leave `INIT.md` in place and report the conflict.
5. Initialize and verify SQLite:

   ```sh
   if [ ! -e .agent-kb/kb.sqlite ]; then
     ./kb init
   fi
   ./kb status --json
   ```

   The status command must return a successful JSON envelope whose database path is this physical directory plus `/.agent-kb/kb.sqlite`. The database must be mode `0600`, `.agent-kb` must be mode `0700`, and the vault root permissions must remain unchanged.
6. Only after every check above succeeds, remove this file with `rm INIT.md` and report completion.

Never store secrets or credentials in Markdown or SQLite.
