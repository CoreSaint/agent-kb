# Repository agent guidance

When the user asks to install the portable agent-memory vault from this repository, read and follow [INSTALL.md](INSTALL.md).

Obtain an explicit destination, preserve existing files, and never initialize the repository's source `vault/` directory in place. The copied vault's own `AGENTS.md`, `CONTRACT.md`, `MAP.md`, and `INIT.md` govern bootstrap and use after copying.

For repository development, treat `vault/` as a distributable template and keep runtime state out of it.
