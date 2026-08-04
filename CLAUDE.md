# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repository is currently a bare scaffold. As of this writing:

- The only tracked file is `README.md`, whose entire content is `# Lanla-incomes_expenses`.
- There is no application code, no package manifest (no `package.json`, `requirements.txt`, `pyproject.toml`, etc.), no test framework, no lint/format configuration, and no CI workflows.
- Git history has a single commit ("Initial commit"); `main` and the working branch point at the same commit.

There are no build, lint, or test commands to document yet, and no architecture to describe, because no code exists.

## For future instances

Before relying on this file, re-check the repo state (`git log`, `git ls-files`, look for a manifest file) — the project may have grown since this was written. Once real code, dependencies, and tooling are added, replace this file with the actual commands (build/lint/test/single-test) and a description of the real architecture, rather than continuing to treat it as a scaffold.
