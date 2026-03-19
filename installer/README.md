# Installer

Automated installation, upgrade, and operations tooling for the Verdikta Arbiter Node.

## Directory Layout

| Directory | Purpose |
|---|---|
| `bin/` | Core installer scripts (install, upgrade, deploy, configure) |
| `util/` | Standalone utilities (diagnostics, funding, recovery, registration) |
| `docs/` | MkDocs-based operator documentation |

## Quick Start

```bash
# Full automated install
./bin/install.sh

# Upgrade an existing installation
./bin/upgrade-arbiter.sh

# Check node status
./util/arbiter-status.sh
```

## Documentation

Comprehensive operator documentation lives in `docs/` and is published to [docs.verdikta.com](https://docs.verdikta.com/). To serve locally:

```bash
cd docs
./serve.sh install   # first time only
./serve.sh serve
```

See [docs/README.md](docs/README.md) for full documentation build instructions.
