/**
 * Unit tests for the blank-route normalizer, using the parameter schemas the
 * live tools actually publish (captured from the running Harness).
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isOptionalParameter,
  normalizeBlankRoutes,
  patchToolDefinition,
  targetKeys,
} from '../index.js';

/** The live `list_subagent_models` parameter schema: both parameters optional. */
const LIST_MODELS_PARAMETERS = {
  type: 'object',
  properties: {
    provider: { type: 'string', description: 'Registered LLM provider id. Omit to list providers.' },
    model: { type: 'string', description: 'Exact model id to inspect. Requires provider.' },
  },
};

/** The live `subagent` parameter schema: only description and prompt are required. */
const SUBAGENT_PARAMETERS = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    prompt: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    reasoning_effort: { type: 'string' },
    run_in_background: { type: 'boolean' },
  },
  required: ['description', 'prompt'],
};

/** The live `subagent_fork` schema: no route parameters at all. */
const SUBAGENT_FORK_PARAMETERS = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    prompt: { type: 'string' },
    run_in_background: { type: 'boolean' },
  },
  required: ['description', 'prompt'],
};

/** The live `web_fetch` schema: `url` is required, so it must never be dropped. */
const WEB_FETCH_PARAMETERS = {
  type: 'object',
  properties: { url: { type: 'string' } },
  required: ['url'],
};

/** The live `edit` schema: `new_string` is required and legitimately empty. */
const EDIT_PARAMETERS = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    old_string: { type: 'string' },
    new_string: { type: 'string' },
  },
  required: ['file_path', 'old_string', 'new_string'],
};

const definition = (name, parameters) => ({ name, parameters });

test('optionality is read from the compiled schema', () => {
  assert.equal(isOptionalParameter(LIST_MODELS_PARAMETERS, 'provider'), true);
  assert.equal(isOptionalParameter(SUBAGENT_PARAMETERS, 'provider'), true);
  assert.equal(isOptionalParameter(SUBAGENT_PARAMETERS, 'description'), false);
  assert.equal(isOptionalParameter(WEB_FETCH_PARAMETERS, 'url'), false);
  assert.equal(isOptionalParameter(LIST_MODELS_PARAMETERS, 'absent'), false);
  assert.equal(isOptionalParameter(undefined, 'provider'), false);
});

test('list_subagent_models declares both route parameters', () => {
  assert.deepEqual(targetKeys(definition('list_subagent_models', LIST_MODELS_PARAMETERS)), ['provider', 'model']);
});

test('subagent declares all three route parameters', () => {
  assert.deepEqual(
    targetKeys(definition('subagent', SUBAGENT_PARAMETERS)),
    ['provider', 'model', 'reasoning_effort'],
  );
});

test('a tool with no route parameters is not a target', () => {
  assert.deepEqual(targetKeys(definition('subagent_fork', SUBAGENT_FORK_PARAMETERS)), []);
});

test('required and non-route parameters are never targeted', () => {
  assert.deepEqual(targetKeys(definition('web_fetch', WEB_FETCH_PARAMETERS)), []);
  assert.deepEqual(targetKeys(definition('edit', EDIT_PARAMETERS)), []);
  assert.deepEqual(targetKeys(definition('bash', { type: 'object', properties: { command: { type: 'string' } } })), []);
});

// The exact call that failed in reproduction.
test('the reproduced failing call is repaired', () => {
  const args = { model: '', provider: '' };
  assert.deepEqual(normalizeBlankRoutes(args, ['provider', 'model']), {});
});

test('a half-blank call keeps the meaningful half', () => {
  assert.deepEqual(
    normalizeBlankRoutes({ model: '', provider: 'provider-b' }, ['provider', 'model']),
    { provider: 'provider-b' },
  );
});

test('whitespace is blank too', () => {
  assert.deepEqual(normalizeBlankRoutes({ provider: '   ' }, ['provider']), {});
});

test('real values are preserved byte for byte', () => {
  const args = { provider: 'provider-a', model: 'model-x', reasoning_effort: 'high' };
  assert.equal(normalizeBlankRoutes(args, ['provider', 'model', 'reasoning_effort']), args);
});

test('an already-correct call returns the same object', () => {
  const args = { description: 'd', prompt: 'p' };
  assert.equal(normalizeBlankRoutes(args, ['provider', 'model']), args);
});

test('unrelated and non-string blanks are untouched', () => {
  const args = { description: '', run_in_background: false, provider: '' };
  assert.deepEqual(normalizeBlankRoutes(args, ['provider']), { description: '', run_in_background: false });
});

test('a frozen argument object is never mutated', () => {
  const args = Object.freeze({ provider: '', model: '' });
  const normalized = normalizeBlankRoutes(args, ['provider', 'model']);
  assert.deepEqual(normalized, {});
  assert.deepEqual(args, { provider: '', model: '' });
});

test('non-object arguments pass through', () => {
  for (const value of [undefined, null, 'x', 42, []]) {
    assert.equal(normalizeBlankRoutes(value, ['provider']), value);
  }
});

test('the wrapper repairs a call and stays restorable', async () => {
  const seen = [];
  const target = {
    name: 'list_subagent_models',
    parameters: LIST_MODELS_PARAMETERS,
    async execute(args) {
      seen.push(args);
      return 'ok';
    },
  };
  const patch = patchToolDefinition(target);
  assert.notEqual(patch, undefined);
  assert.deepEqual(patch.keys, ['provider', 'model']);
  assert.equal(await target.execute({ provider: '', model: '' }), 'ok');
  assert.deepEqual(seen, [{}]);
  patch.restore();
  assert.equal(await target.execute({ provider: '', model: '' }), 'ok');
  assert.deepEqual(seen[1], { provider: '', model: '' });
});

test('a required-empty argument survives a real execute path', async () => {
  const seen = [];
  const target = {
    name: 'edit',
    parameters: EDIT_PARAMETERS,
    async execute(args) {
      seen.push(args);
      return 'ok';
    },
  };
  assert.equal(patchToolDefinition(target), undefined);
  await target.execute({ file_path: 'f', old_string: 'x', new_string: '' });
  assert.equal(seen[0].new_string, '');
});

test('an unwrappable definition raises a diagnostic error', () => {
  const target = {
    name: 'subagent',
    parameters: SUBAGENT_PARAMETERS,
    execute: async () => 'ok',
  };
  Object.defineProperty(target, 'execute', { value: target.execute, writable: false });
  assert.throws(() => patchToolDefinition(target), /not a writable own property/);
});

test('an inherited execute is rejected rather than silently shadowed', () => {
  const proto = { execute: async () => 'ok' };
  const target = { name: 'subagent', parameters: SUBAGENT_PARAMETERS };
  Object.setPrototypeOf(target, proto);
  assert.throws(() => patchToolDefinition(target), /not a writable own property/);
});
