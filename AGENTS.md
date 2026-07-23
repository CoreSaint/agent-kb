# Repository agent guidance

When the user asks to install the portable agent-memory vault from this repository or from a release archive, read and follow [INSTALL.md](INSTALL.md).

Obtain an explicit destination, preserve existing files, and never initialize the repository's source `vault/` directory in place. Prefer the versioned release archive and its `install.sh` entry point; after copying, the copied vault's own `AGENTS.md`, `CONTRACT.md`, `MAP.md`, and `INIT.md` govern bootstrap and use.

For repository development, treat `vault/` as a distributable template and keep runtime state out of it.
