# Repository Standard

Authoritative specification for every repository owned by this account. A repository is compliant
when `./scripts/repository-check` passes; nothing else counts as evidence.

## Purpose

One standard, applied to every repository. The goal is not that repositories look alike; it is that
the same rule has exactly one implementation and one place to change it. A repository must never
re-implement, fork, or drift from a shared rule because its author preferred a different shape.

## Canon

`HughZadora/repo-template` is the single source of truth (the canon). Every shared file, check,
workflow, and convention is defined there first. A repository consumes the canon by one of two
mechanisms:

Every shared file is a byte-identical copy of its canon source, verified through the SHA-256
manifest embedded in `scripts/repository-check`. The CI workflow carries no policy of its own: it
runs the checker and the validation command declared in `project.yaml`, so every rule lives in one
place. Keeping the workflow byte-identical also avoids a public repository depending on the private
canon repository at CI time.

Never edit a copy. Change the canon, bump the manifest, roll the change out.

## Tiers

Every repository declares exactly one `type` in `project.yaml`. The tier fixes the required file
set; it is never decided per repository or per change.

| Type          | Repositories                                                                                      | Meaning                                 |
| ------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `template`    | repo-template                                                                                     | Canon and bootstrap source              |
| `application` | rc-kitchen-china-website, rc-kitchen-offical-website, markdown-viewer-extension, novel-tts-reader | Shipped software with a runtime         |
| `meta`        | .github                                                                                           | Account-level community health files    |
| `asset`       | rc-kitchen-visual-assets                                                                          | Media is the deliverable                |
| `deploy`      | erpnext-cn-deploy                                                                                 | Deployment and operating procedures     |
| `firmware`    | openwrt-ax3000t-an8855                                                                            | Builds and patches third-party firmware |
| `infra`       | workbench-control-plane                                                                           | Machine and network state               |
| `model`       | XY6020-freecad                                                                                    | Generated CAD and parametric models     |

## Core requirements (every tier)

1. `project.yaml` matches the schema below.
2. `README.md` is the human entry point and contains a `## Validation` section.
3. `AGENTS.md` contains `# Agent Instructions`, `## Scope`, `## Working rules`, and `## Validation`.
4. `.editorconfig`, `.gitattributes`, `.markdownlint.yaml`, `.github/dependabot.yml`, and
   `scripts/repository-check` are byte-identical to the canon.
5. `.gitignore` contains the canon baseline block verbatim, including its `# >>> canon baseline` and
   `# <<< canon baseline` markers. Additional repository-specific ignores go outside the block.
6. `.github/workflows/repository-baseline.yml` is byte-identical to the canon. It runs the checker
   and the `validation` command from `project.yaml`, and holds no policy of its own.
7. External GitHub Actions are referenced by full commit SHA.
8. No generated output is tracked: no `*.pyc`, `*.pyo`, `__pycache__/`, `*.step`, `*.stl`,
   `artifacts/`, `dist/`, `build/`, `coverage/`, or `node_modules/`. The `asset` tier explicitly
   exempts image and media files under `output/`, which are the deliverable rather than build
   output.
9. Scripts under `scripts/` are POSIX `sh` unless they begin with `#!/usr/bin/env bash`, carry the
   executable bit in Git, and pass `sh -n` or `bash -n`.
10. `docs/zh-CN/` holds non-authoritative Chinese mirrors only. Each mirror begins with
    `<!-- non-authoritative mirror: authoritative source: <path> -->` and `<path>` must exist
    (warning until phase 2 completes).

## project.yaml schema

Flat keys only. One `key: value` per line, no tabs, no nesting, no quoting requirement.

```yaml
version: 1
name: repo-template
type: template
purpose: Canon and bootstrap source for every repository
status: active
validation: ./scripts/repository-check
```

| Key          | Required | Values                                   |
| ------------ | -------- | ---------------------------------------- |
| `version`    | yes      | `1`                                      |
| `name`       | yes      | Must equal the repository directory name |
| `type`       | yes      | One of the tier values                   |
| `purpose`    | yes      | Single line                              |
| `status`     | yes      | `active`, `maintenance`, or `archived`   |
| `validation` | no       | Single local command, safe to run in CI  |

## Shared configuration

Formatting policy is identical everywhere; only the language coverage differs.

| File                                  | Requirement                                           | Applies to    |
| ------------------------------------- | ----------------------------------------------------- | ------------- |
| `.editorconfig`                       | Byte-identical                                        | All           |
| `.markdownlint.yaml`                  | Byte-identical                                        | All           |
| `.prettierrc.json`, `.prettierignore` | Byte-identical                                        | `application` |
| `ruff.toml`                           | Byte-identical                                        | `model`       |
| `mise.toml`                           | Present for `application`, and must declare `[tools]` | `application` |

`mise.toml` pins tool versions deliberately per repository, so its values are not unified; the tool
set is. Node and pnpm are declared together so no repository pins a package manager independently of
its runtime.

## Conventions

Naming, comments, and text follow one rule set so that a reader moving between repositories does not
relearn anything.

- Directories: `scripts/`, `docs/`, `tests/`, `.github/`. Nothing parallel.
- Script names are verb phrases (`repository-check`, `install-environment`), lowercase,
  hyphen-separated. A `.sh` suffix is permitted for shell scripts.
- Files and directories are lowercase and hyphen-separated unless the ecosystem mandates otherwise
  (`package.json`, `AGENTS.md`, `README.md`).
- Every script and non-trivial module starts with a comment stating what it does and why it exists,
  not how each line works.
- Comments explain intent and constraints. They never restate the code.
- Commit messages follow Conventional Commits: `type(scope): summary`, with `type` in `feat`, `fix`,
  `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Pull request titles follow the same form; bodies state problem, change, and evidence.
- Line length is 100 for Markdown, code, and configuration.
- Indentation is two spaces, four for Python, tabs for `Makefile`.

## Language policy

English is authoritative. Chinese exists only as a mirror translation for internal management and is
never the source of truth.

- `README.md`, `AGENTS.md`, `STANDARD.md`, `docs/`, code comments, identifiers, commit messages,
  pull requests, and issues are written in English.
- Chinese mirrors live under `docs/zh-CN/`, carry the non-authoritative header, and never add or
  remove information relative to the English source.
- Phase 1 does not translate or delete existing Chinese documents. They stay byte-identical and are
  listed in the phase 2 backlog.

## Phase boundaries

Phase 1 (this standard's first delivery) covers deterministic, machine-checkable unification: shared
files, the checker, CI, `project.yaml`, directory and script conventions, comment headers, and
tracked-output hygiene.

Phase 2 covers content: promoting existing Chinese documents to English authoritative sources and
rebuilding them as mirrors under `docs/zh-CN/`.

## Glossary

| Term           | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| canon          | `HughZadora/repo-template`; the single authoritative definition |
| tier           | The `type` value in `project.yaml`; fixes required files        |
| baseline       | The canon-conformant file set every repository must carry       |
| manifest       | SHA-256 table embedded in `scripts/repository-check`            |
| mirror         | Non-authoritative Chinese translation under `docs/zh-CN/`       |
| tracked output | Generated file committed to Git; always a defect                |

## Changing the standard

1. Change the canon, including `STANDARD.md` and any shared file.
2. Run `./scripts/update-canon-manifest` and commit the regenerated manifest.
3. Run `./scripts/repository-check --strict` and `./tests/run.sh`.
4. Roll the byte-identical files out to every repository and open a pull request per repository.
