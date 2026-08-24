# DSH Skill Manager

[简体中文](README.zh.md)

A small, security-focused local Skill manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web.

![DSH Skill Manager showing invocation controls in each Skill row](docs/skill-manager.png)

## What it does

- Lists the winning local Skills for the current DSH session and project.
- Searches names, descriptions, sources, providers, and paths.
- Loads instructions only when a row is expanded.
- Shows source, provider, and resolved file path.
- Places **Automatic** and **/name** invocation controls directly in every list row.
- Keeps bundled, symbolic-link, runtime, and non-file Skills read-only.

It deliberately does not install, delete, create, sync, or market Skills. It manages the invocation policy of Skills already discovered by DSH.

## Install

Requires Node.js `^22.19.0 || >=24.0.0` and a DSH Web profile compatible with the `0.1.0-rc.7` or `0.1.1-rc.2` SDK family.

Install directly from GitHub:

```bash
dsh plugin --profile web add github:SLin-code/dsh-skill-manager
```

The Git dependency builds both plugin faces during installation; no checked-in build artifacts are required.

Restart `dsh web`, open **Settings → Plugins → Skill Manager**, and select a session. To remove it:

```bash
dsh plugin --profile web remove dsh-skill-manager
```

For local development:

```bash
npm install
npm run typecheck
npm test
npm run build
dsh plugin --profile web add .
```

## Security model

The browser sends only the current `sessionId`, exact Skill name, and the two invocation booleans. It never supplies a filesystem path. The Host resolves the session's project directory and the winning Skill through the official `ctx.sessions` and `ctx.skills` services on every operation.

Mutation routes accept loopback, same-origin requests only. Before writing, the Host revalidates the YAML frontmatter and Skill identity, rejects bundled and symbolic-link entries, takes a cross-process lock, and performs an atomic same-directory replacement. Existing body text and YAML comments are preserved where possible.

The two canonical frontmatter fields are:

```yaml
disable-model-invocation: false
user-invocable: true
```

## Architecture

This repository is a standalone dual-face DSH plugin:

- `cordis.patch.yml` mounts one plugin row into a selected profile.
- `src/index.ts` is the Host half and registers loopback API routes.
- `src/client/index.tsx` is the browser half and registers an official Settings slot.
- `dsh.bundle.patch` and `dsh.client` in `package.json` connect both halves without patching DSH source.

## Development

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## License

[MIT](LICENSE)
