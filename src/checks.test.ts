// The runnable checks the BUILD-SPEC asks for: prompt detection, routing
// helpers, quoting, TLDR extraction. Mirrors dispatch.py --selftest.
// Run: npm test  (node --test over dist/server/)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credsFileFor, looksLikePrompt } from './cate'
import { tldrFromTranscript } from './hook'
import { parseJson, tabTitle, taskName } from './pipeline'
import { answersBlock } from './server'
import { claudeCommand, shq } from './spawn'

test('parseJson: dispatch.py selftest cases', () => {
  assert.deepEqual(parseJson('noise {"a": 1} noise'), { a: 1 })
  assert.throws(() => parseJson('no json here'))
})

test('taskName: dispatch.py selftest cases', () => {
  assert.equal(taskName('phq9-measurement-invariance', []), 'phq9-1')
  assert.equal(taskName('phq9-x', ['phq9-1', 'phq9-2']), 'phq9-3')
  assert.equal(taskName('dispatch', [], 'Fix Tab Titles!'), 'fix-tab-titles-1')
  assert.equal(taskName('dispatch', [], ''), 'dispatch-1')
})

test('tabTitle', () => {
  assert.equal(tabTitle('/x/phq9-measurement-invariance', 'phq9-1'), 'phq9-measurement-invariance · phq9-1')
})

test('looksLikePrompt: real shell screens', () => {
  assert.ok(looksLikePrompt('Last login: Mon\nabhay@mac cate-dispatch % '))
  assert.ok(looksLikePrompt('~/code ❯'))
  assert.ok(looksLikePrompt('bash-5.2$ '))
  assert.ok(!looksLikePrompt(''))
  assert.ok(!looksLikePrompt('Cloning into repo...\nReceiving objects: 42%'))
  // trailing blank lines after the prompt (terminal screens pad with them)
  assert.ok(looksLikePrompt('abhay@mac % \n\n\n'))
})

test('credsFileFor mirrors the zsh ${PWD//\\//%} encoding', () => {
  assert.ok(credsFileFor('/Users/abhay/proj').endsWith('/%Users%abhay%proj.json'))
})

test('shq survives single quotes', () => {
  assert.equal(shq("it's"), `'it'\\''s'`)
})

test('claudeCommand shape: cd first, no skip-permissions, settings file, add-dirs', () => {
  const cmd = claudeCommand('/tmp/wt/sub', '/specs/x-1.md', '/settings/x-1.json', ['/a b', '/c'])
  // Subshell keeps the panel's root zsh in the workspace root (session restore).
  assert.ok(cmd.startsWith(`( cd '/tmp/wt/sub' && claude `) && cmd.endsWith(')'))
  assert.ok(cmd.includes(`--settings '/settings/x-1.json'`))
  assert.ok(cmd.includes(`"$(cat '/specs/x-1.md')"`))
  assert.ok(cmd.includes(`--add-dir '/a b' --add-dir '/c'`))
  assert.ok(!cmd.includes('--dangerously-skip-permissions'))
})

test('tldrFromTranscript: last assistant text wins, 600-char cap', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'final answer' }] } }),
    'not json at all',
  ].join('\n')
  assert.equal(tldrFromTranscript(lines), 'final answer')
  const long = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x'.repeat(700) }] },
  })
  assert.equal(tldrFromTranscript(long).length, 601)
})

test('answersBlock: assumptions + Q/A with defaults for blanks', () => {
  const plan = {
    profile: 'projects',
    repo: null,
    slug: 's',
    questions: [
      { q: 'Which file?', default: 'a.ts' },
      { q: 'Tests too?', default: 'yes' },
    ],
    assumptions: ['scope is small'],
  }
  assert.equal(
    answersBlock(plan, ['b.ts', '']),
    'Assumed: scope is small\nQ: Which file?\nA: b.ts\nQ: Tests too?\nA: yes',
  )
  assert.equal(answersBlock({ ...plan, questions: [], assumptions: [] }, []), '')
})
