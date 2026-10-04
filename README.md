# dsh-plugin-empty-arg-fix

Treat blank optional route arguments as omitted, so that models which send
`provider` and `model` as empty strings can list and select subagent models.

## The problem

Some model families — reproduced live with the `gpt-6.x` family behind an
OpenAI-Responses-compatible relay provider — send **every** optional string
parameter as `""` instead of omitting the key:

```json
{ "model": "", "provider": "" }
```

The Harness tool layer branches on `value !== undefined`, so `""` reads as an
explicit choice rather than an absent one and hard-fails:

| Tool | Error |
| --- | --- |
| `list_subagent_models` | `` `provider` must be non-empty `` |
| `subagent` | ``child LLM `provider` must be non-empty`` |

The identical call with the keys omitted succeeds, so the defect is purely in the
spelling of "not specified". The failure is not a harness auto-fill, and it is not
adapter- or protocol-specific.

## What this plugin does

It wraps the `execute` of the affected tools and drops route arguments that
arrived blank, so downstream code sees exactly what it sees when the model omits
the key.

It is deliberately narrow:

- **Only route selectors** — `provider`, `model`, `reasoning_effort`. There is no
  provider or model whose id is the empty string.
- **Only where the tool's own schema marks the parameter optional.** A required
  parameter (`web_fetch.url`) is never touched, and neither is one that
  legitimately accepts `""` (`edit.new_string`, used to delete matched text).
- **Only the top level.** A `workflow` phase's nested `provider` is out of scope.
- Whitespace-only values are blank too. Real ids are preserved byte for byte, and
  a frozen argument object is copied, never mutated.

## Why it patches `execute`

This is the weakest mechanism that can work:

- **`tools/pre-execute` cannot.** Its decision type is
  `{ kind: 'allow' | 'deny' | 'ask' | 'cancel' }` with no field carrying
  replacement arguments, and the registry deep-freezes the arguments *before*
  that waterfall runs.
- **`tools/execute` cannot.** Its contract states wrappers may change only
  `exec.signal`.
- **Re-registering cannot.** The delegation tools register into each agent's own
  scope layer, and `NamedEntries.insert` throws on a duplicate name within one
  layer.

`defineTool` creates `execute` as a writable own property and dispatch re-resolves
the definition at call time, so an in-place wrapper runs. This is the same
approach the installed `dsh-plugin-sandbox-escalation-fix` uses.

The plugin rescans on `tools/change`, `agent/created`, and `agent/disposed`, skips
any definition it cannot wrap (logging a warning instead of failing registration),
and restores every original `execute` when it unloads.

## Install

Install the bundle through the Plugin Manager (`install_bundle`) with the
absolute path to this directory as the target. From a source checkout:

```bash
dsh plugin --profile <profile> add /abs/path/to/dsh-plugin-empty-arg-fix
```

This mirrors `dsh-plugin-sandbox-escalation-fix`, which fixes the same class of
problem for sandbox arguments.

## Configuration

None. The plugin declares no `Config`; the affected tools and parameters are
fixed by the Harness.

## Tests

```bash
node --test test/
```

The tests use the parameter schemas the live tools actually publish, and include
the exact reproduced failing call.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
