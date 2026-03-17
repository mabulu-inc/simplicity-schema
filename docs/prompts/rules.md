# Project Rules

<!-- These rules are injected into every boot prompt via {{project.rules}}.
     They apply to every task and every agent. Edit freely. -->

- Do NOT use TodoWrite — it wastes turns and provides no value in a stateless loop
- All production code goes under `src/`
- Tests go under `src/__tests__/`
- File naming: kebab-case
- Do NOT explore library internals (node_modules) unless a specific error requires it
