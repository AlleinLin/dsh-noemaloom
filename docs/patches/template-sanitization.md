# Imported template example adaptations

These local edits retain the imported assets, their behavior, locale keys, license
notices, and source attribution. They generalize example credential values and
personal workspace paths for distribution. The source snapshots remain identified
by `sources.lock.json`; this note does not claim the edited files are verbatim
upstream copies.

- `src/domain/resources/agents/builtin.ts` retains the complete bilingual personas
  from `MichengAI/dsh-agency-agents` under Apache-2.0. The English
  `security-ai-generated-code-auditor` uses an explicit dummy API key for its
  hardcoded-secret counterexample and explains that an actual exposed credential
  must be rotated. The Chinese `testing-api-tester` uses an explicit dummy test
  password.
- `src/domain/workflow/prompt-seed.ts` retains attribution to
  `csyangwen/dsh-memory-evolve` prompt seed v3 and its named SpecRoute and
  Claude-Code-Promts-Skills sources. Only example API keys and passwords in the
  security, testing, and technical-documentation templates are generalized to
  explicit dummy values. Matching test input and expectation values stay equal.
  The seed's source description now discloses this adaptation.
- `src/client/upstream-ru/pack/task-board.ts` retains its
  `packages/dsh-task-board` source attribution and all Russian locale keys. Its
  Unix project-path placeholder uses `/srv/project`.
- `assets/methods/aegis/systematic-debugging/root-cause-tracing.md` retains the
  imported root-cause tracing method. Its illustrative error uses
  `/workspace/project/packages/core` instead of an author's home directory.

The dummy credential strings are public teaching and test placeholders. The
hardcoded-secret example continues to describe an insecure implementation pattern;
it does not contain a usable credential.
