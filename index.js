/**
 * `empty-arg-fix` — treat blank optional route arguments as omitted.
 *
 * Some model families (reproduced live with the `gpt-6.x` family behind an
 * OpenAI-Responses-compatible relay) send every optional string parameter as
 * `""` instead of omitting the key. The Harness tool layer branches on
 * `value !== undefined`, so `""` reads as an explicit choice and hard-fails:
 *
 *   - `list_subagent_models` → "`provider` must be non-empty"
 *   - `subagent`             → "child LLM `provider` must be non-empty"
 *
 * The same call with the key omitted succeeds, so the only defect is the
 * spelling. This plugin makes the two spellings equivalent before the tool
 * body's own non-empty checks run.
 *
 * ## Why this wraps `execute` instead of listening to an event
 *
 * A `tools/pre-execute` listener cannot do it. That waterfall's decision type is
 * `{ kind: 'allow' | 'deny' | 'ask' | 'cancel' }` with no field that carries
 * replacement arguments, and the registry builds the execution as
 * `arguments: deepFreeze(snapshotJsonValue(...))` *before* the waterfall runs.
 * `tools/execute` documents that wrappers "may change only `exec.signal`".
 *
 * Re-registering a shadowing definition cannot do it either: the delegation
 * tools register into each agent's own scope layer, and `NamedEntries.insert`
 * throws on a duplicate name within one layer, so a second same-named tool
 * cannot be registered on the same `agent.ctx`.
 *
 * Patching `definition.execute` in place is the weakest mechanism that works,
 * and it is the same approach the installed `dsh-plugin-sandbox-escalation-fix`
 * uses. `defineTool` creates `execute` as a writable own property, and dispatch
 * re-resolves the definition at call time, so the replacement runs.
 *
 * ## Scope of the change
 *
 * Only route selectors (`provider`, `model`, `reasoning_effort`) are considered,
 * and only where the tool's own schema marks them optional. A required parameter
 * (such as `web_fetch.url`) is never touched, and neither is a parameter that
 * legitimately accepts an empty string (such as `edit.new_string`, used to delete
 * text). Nested keys — for example a `workflow` phase's `provider` — are out of
 * scope, because only the top-level argument object is normalized.
 *
 * This module deliberately has no imports: a profile-installed bundle resolves
 * from the profile's own `node_modules`, which does not contain `@deepseek-ai/*`.
 *
 * @module dsh-plugin-empty-arg-fix
 */

/** The plugin's display and diagnostic name. */
export const name = 'empty-arg-fix';

/** Services this plugin requires; it stays inactive in a profile without them. */
export const inject = ['agents', 'tools'];

/**
 * Argument names that select an LLM route. A blank value here always means "not
 * specified" — there is no provider or model whose id is the empty string.
 */
export const ROUTE_PARAMETERS = ['provider', 'model', 'reasoning_effort'];

/**
 * Tools that may carry top-level route selectors. The optionality gate below
 * decides which of them are actually patched, so a name in this list that
 * declares no route parameter (for example `subagent_fork` with child model
 * selection disabled) is simply skipped.
 */
export const ROUTE_TOOL_NAMES = [
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'list_subagent_models',
  'workflow',
];

/** @returns whether the value is a plain object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether one parameter may be omitted, according to the tool's own schema.
 *
 * `defineTool` compiles parameters to `{ type: 'object', properties, required? }`,
 * where `required` is omitted entirely when no parameter is required.
 *
 * @param parameters - the definition's compiled parameter schema.
 * @param key - the parameter name.
 * @returns whether the key is declared and optional.
 */
export function isOptionalParameter(parameters, key) {
  if (!isRecord(parameters)) return false;
  const properties = parameters.properties;
  if (!isRecord(properties) || !Object.hasOwn(properties, key)) return false;
  const required = parameters.required;
  if (!Array.isArray(required)) return true;
  return !required.includes(key);
}

/**
 * The route parameters this definition declares as optional.
 *
 * @param definition - a registered tool definition.
 * @returns the names to normalize; empty when the definition is not a target.
 */
export function targetKeys(definition) {
  if (!isRecord(definition) || typeof definition.name !== 'string') return [];
  if (!ROUTE_TOOL_NAMES.includes(definition.name)) return [];
  return ROUTE_PARAMETERS.filter((key) => isOptionalParameter(definition.parameters, key));
}

/**
 * Drop blank route arguments from one call.
 *
 * A whitespace-only id can never name a provider or model either, so it is
 * treated as blank.
 *
 * @param args - the model-supplied arguments.
 * @param keys - the route parameter names to normalize.
 * @returns the same object when nothing changed, otherwise a shallow copy.
 */
export function normalizeBlankRoutes(args, keys) {
  if (!isRecord(args) || keys.length === 0) return args;
  let changed = false;
  const normalized = { ...args };
  for (const key of keys) {
    if (!Object.hasOwn(normalized, key)) continue;
    const value = normalized[key];
    if (typeof value !== 'string') continue;
    if (value.trim().length !== 0) continue;
    delete normalized[key];
    changed = true;
  }
  return changed ? normalized : args;
}

/**
 * Install a pass-through normalizer on one tool definition.
 *
 * @param definition - the tool definition to wrap.
 * @returns the installed patch, or `undefined` when the definition is no target.
 */
export function patchToolDefinition(definition) {
  const keys = targetKeys(definition);
  if (keys.length === 0) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(definition, 'execute');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.writable !== true) {
    throw new Error(`tool "${definition.name}" execute is not a writable own property`);
  }
  const mutable = definition;
  const original = definition.execute;
  let active = true;
  const wrapped = async function (args, exec) {
    // A frozen argument object is never mutated; a copy is forwarded instead.
    const forward = active ? normalizeBlankRoutes(args, keys) : args;
    return original.call(this, forward, exec);
  };
  try {
    mutable.execute = wrapped;
    if (definition.execute !== wrapped) throw new Error('the assignment did not install the wrapper');
  } catch (error) {
    active = false;
    try {
      if (definition.execute === wrapped) mutable.execute = original;
    } catch {
      // Preserve the first installation failure.
    }
    throw new Error(`failed to wrap tool "${definition.name}" execute: ${String(error)}`);
  }
  return {
    definition,
    keys,
    restore() {
      active = false;
      try {
        if (definition.execute === wrapped) mutable.execute = original;
      } catch {
        // An inactive wrapper is a safe pass-through if another owner froze it.
      }
    },
  };
}

/**
 * Patch every visible target definition, in the global view and per agent.
 *
 * @param ctx - the Host context owning `tools` and `agents`.
 */
export function apply(ctx) {
  /** Installed patches, keyed by the definition that owns them. */
  const patches = new Map();
  /** Definitions that refused patching, so a rescan does not retry them. */
  const incompatible = new WeakSet();

  const restore = (selected) => {
    for (const patch of [...selected].reverse()) {
      patches.delete(patch.definition);
      patch.restore();
    }
  };
  const restoreAll = () => {
    const active = [...patches.values()];
    patches.clear();
    for (const patch of active.reverse()) patch.restore();
  };
  const errorText = (error) => {
    try {
      return error instanceof Error ? error.message : String(error);
    } catch {
      return 'unprintable error';
    }
  };
  const warnSafely = (source, error) => {
    try {
      ctx.logger?.warn?.(`empty-arg-fix: skipped ${source}: ${errorText(error)}`);
    } catch {
      // A compatibility warning must never veto tool or agent registration.
    }
  };
  const patchVisibleTools = (agent, added) => {
    for (const toolName of ROUTE_TOOL_NAMES) {
      const definition = ctx.tools.get(toolName, agent);
      if (definition === undefined || patches.has(definition) || incompatible.has(definition)) continue;
      let patch;
      try {
        patch = patchToolDefinition(definition);
      } catch (error) {
        incompatible.add(definition);
        warnSafely(`tool "${toolName}"`, error);
        continue;
      }
      if (patch === undefined) continue;
      patches.set(definition, patch);
      added.push(patch);
    }
  };
  const scanTransaction = (agents) => {
    const added = [];
    try {
      for (const agent of agents) patchVisibleTools(agent, added);
    } catch (error) {
      restore(added);
      throw error;
    }
  };
  const scanAll = () => {
    scanTransaction([undefined, ...ctx.agents.list()]);
  };
  const scanSafely = (source, selectAgents, pruneInvisible) => {
    let agents;
    try {
      agents = selectAgents();
    } catch (error) {
      warnSafely(`${source} scope scan`, error);
      return;
    }
    const visible = new Set();
    let complete = true;
    for (const agent of agents) {
      for (const toolName of ROUTE_TOOL_NAMES) {
        try {
          const definition = ctx.tools.get(toolName, agent);
          if (definition !== undefined) visible.add(definition);
        } catch (error) {
          complete = false;
          warnSafely(`${source} tool "${toolName}" lookup`, error);
        }
      }
    }
    try {
      scanTransaction(agents);
    } catch (error) {
      warnSafely(`${source} scan`, error);
      return;
    }
    if (!pruneInvisible || !complete) return;
    // A definition no longer visible in any scope keeps no wrapper.
    for (const [definition, patch] of [...patches]) {
      if (visible.has(definition)) continue;
      patches.delete(definition);
      patch.restore();
    }
  };

  ctx.effect(() => {
    let stopChange;
    let stopCreated;
    let stopDisposed;
    try {
      scanAll();
      stopChange = ctx.on('tools/change', () => {
        scanSafely('runtime', () => [undefined, ...ctx.agents.list()], true);
      });
      stopCreated = ctx.on('agent/created', ({ agent }) => {
        scanSafely('new agent', () => [agent], false);
      });
      stopDisposed = ctx.on('agent/disposed', () => {
        scanSafely('agent disposal', () => [undefined, ...ctx.agents.list()], true);
      });
    } catch (error) {
      stopDisposed?.();
      stopCreated?.();
      stopChange?.();
      restoreAll();
      throw error;
    }
    return () => {
      stopDisposed?.();
      stopCreated?.();
      stopChange?.();
      restoreAll();
    };
  }, 'empty-arg-fix.lifecycle()');
}
