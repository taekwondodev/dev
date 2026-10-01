# Dispatch notes

## Rules to paste

```json
"rules": {
  "code-review": { "harness": "pi", "model": "openai/gpt-6-luna" },
  "interrogate": { "harness": "pi", "model": "openai/gpt-6-luna" },
  "implement": { "harness": "pi", "model": "openai/gpt-6-luna" },
  "investigation": { "harness": "pi", "model": "openai/gpt-6-luna" },
  "how": { "harness": "pi", "model": "openai/gpt-6-luna" },
  "coding-standards": { "harness": "pi", "model": "openai/gpt-6-luna" },
  "arena": { "harness": "pi", "model": "openai/gpt-6-luna" }
}
```

## Why each rule

- **code-review**: Equal strength, another provider. A reviewer judges the lead's own work; a different model family shares fewer of its blind spots, and a weaker one lowers the gate.
- **interrogate**: Equal or stronger, another provider. The adversarial worker hunts what the lead missed; it cannot be weaker than the author of the mistake.
- **implement**: Equal strength, same provider is fine. A writer leaf produces code the lead then reviews; a weaker model moves the cost into review rounds and fixes.
- **investigation**: Equal strength. Root-cause work is reasoning heavy; it gains little from provider diversity and loses a lot from a cheaper model.
- **how**: Cheaper. Read-only tracing over many files needs a large context and fast reads, and the lead verifies the merged findings; a smaller model is enough.
- **coding-standards**: Cheaper. Delegated research is search and extraction with cited sources; a smaller model with reliable tool use is enough.
- **arena**: Equal strength. Candidates are compared by the lead; ideally each candidate comes from a different provider, which one rule per skill cannot express.
