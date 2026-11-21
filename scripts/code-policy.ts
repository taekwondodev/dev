import { relative } from 'node:path'
import type { RuleTester } from 'oxlint/plugins-dev'
import { internalTerm } from './model-text-terms.ts'

type Rule = Parameters<RuleTester['run']>[1]
type Visitor = ReturnType<Extract<Rule, { createOnce: unknown }>['createOnce']>
type NodeOf<K extends keyof Visitor> = Parameters<NonNullable<Visitor[K]>>[0]
type Call = NodeOf<'CallExpression'>
type Construction = NodeOf<'NewExpression'>
type Import = NodeOf<'ImportDeclaration'>

const WAIT_MODULE = 'tests/wait.ts'
const TIMER_MODULES = new Set(['node:timers/promises', 'timers/promises'])
const EFFECT_MODULES = new Set(['effect', 'effect/Effect'])
const DIRECTIVE = /^\s*(?:oxlint|eslint)-(?:disable|enable)/
const QUERY_LANGUAGE =
  /^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+(?:OR\s+\w+\s+)?INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX)\b|PRAGMA\s+\w+|(?:BEGIN(?:\s+(?:EXCLUSIVE|IMMEDIATE))?|COMMIT|ROLLBACK)\s*$|query\()/
const PROSE = /\S\s+\S/
const MESSAGE_LABEL = /^dev\/[a-z0-9-]+$/
const WORDS = /[A-Za-z]{2}/
const CONSTANT_SHAPES = new Set(['ObjectExpression', 'TSAsExpression', 'TSSatisfiesExpression'])
const FILE_START = { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }

const importedName = (specifier: Import['specifiers'][number]): string | undefined => {
  if (specifier.type !== 'ImportSpecifier') return undefined
  const { imported } = specifier
  return imported.type === 'Identifier' ? imported.name : imported.value
}

const objectPath = (object: Call['callee']): string[] | undefined => {
  if (object.type === 'Identifier') return [object.name]
  if (
    object.type === 'MemberExpression' &&
    !object.computed &&
    object.object.type === 'Identifier' &&
    object.property.type === 'Identifier'
  )
    return [object.object.name, object.property.name]
  return undefined
}

const memberOf = (callee: Call['callee']): { object: string[]; property: string } | undefined => {
  if (callee.type !== 'MemberExpression' || callee.computed) return undefined
  if (callee.property.type !== 'Identifier') return undefined
  const object = objectPath(callee.object)
  return object && { object, property: callee.property.name }
}

const callsName = (node: unknown, name: string): boolean =>
  typeof node === 'object' &&
  node !== null &&
  'type' in node &&
  node.type === 'CallExpression' &&
  'callee' in node &&
  typeof node.callee === 'object' &&
  node.callee !== null &&
  'type' in node.callee &&
  node.callee.type === 'Identifier' &&
  'name' in node.callee &&
  node.callee.name === name

const onlyCalls = (callback: Call['arguments'][number] | undefined, name: string): boolean => {
  if (callback === undefined) return false
  if (callback.type === 'Identifier') return callback.name === name
  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
    return false
  const { body } = callback
  if (body === null) return false
  if (body.type !== 'BlockStatement') return callsName(body, name)
  const [statement, ...rest] = body.body
  return rest.length === 0 && statement?.type === 'ExpressionStatement'
    ? callsName(statement.expression, name)
    : false
}

const resolvesOnTimer = (node: Construction): boolean => {
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'Promise') return false
  const [executor] = node.arguments
  if (executor?.type !== 'ArrowFunctionExpression' && executor?.type !== 'FunctionExpression')
    return false
  const [resolve] = executor.params
  if (resolve?.type !== 'Identifier' || executor.body === null) return false
  const calls =
    executor.body.type === 'BlockStatement'
      ? executor.body.body.flatMap(statement =>
          statement.type === 'ExpressionStatement' ? [statement.expression] : []
        )
      : [executor.body]
  return calls.some(
    call =>
      call.type === 'CallExpression' &&
      callsName(call, 'setTimeout') &&
      onlyCalls(call.arguments[0], resolve.name)
  )
}

const written = (template: NodeOf<'TemplateLiteral'>): string =>
  template.quasis.map(quasi => quasi.value.cooked ?? '').join('…')

type Node = NonNullable<NodeOf<'Identifier'>['parent']>

const parentOf = (node: Node): Node | undefined => node.parent ?? undefined

const joins = (node: Node | undefined): node is NodeOf<'BinaryExpression'> =>
  node?.type === 'BinaryExpression' && node.operator === '+'

const writtenWords = (node: Node, except: Node): boolean => {
  if (node === except) return false
  if (node.type === 'Literal') return typeof node.value === 'string' && WORDS.test(node.value)
  if (node.type === 'TemplateLiteral') return WORDS.test(written(node))
  return joins(node) && (writtenWords(node.left, except) || writtenWords(node.right, except))
}

const sentenceAround = (node: Node): boolean => {
  let outer = parentOf(node)
  while (
    outer !== undefined &&
    (outer.type === 'ConditionalExpression' ||
      outer.type === 'LogicalExpression' ||
      outer.type === 'CallExpression' ||
      (joins(outer) && joins(parentOf(outer))))
  )
    outer = parentOf(outer)
  if (outer?.type === 'TemplateLiteral') return WORDS.test(written(outer))
  return joins(outer) && writtenWords(outer, node)
}

type Key = string | undefined

const staticKey = (key: Node, computed: boolean): Key => {
  if (!computed && key.type === 'Identifier') return key.name
  return key.type === 'Literal' ? String(key.value) : undefined
}

interface HeldValue {
  readonly constant: NodeOf<'VariableDeclarator'>
  readonly keys: readonly Key[]
}

const constantHolding = (node: Node): HeldValue | undefined => {
  const keys: Key[] = []
  let value = node
  for (;;) {
    const holder = parentOf(value)
    if (holder === undefined) return undefined
    if (holder.type === 'VariableDeclarator') {
      const declaration = parentOf(holder)
      return holder.init === value &&
        declaration?.type === 'VariableDeclaration' &&
        declaration.kind === 'const'
        ? { constant: holder, keys: holder.id.type === 'Identifier' ? keys : [] }
        : undefined
    }
    if (holder.type === 'Property') {
      if (holder.value !== value) return undefined
      keys.unshift(staticKey(holder.key, holder.computed))
    } else if (holder.type === 'ArrayExpression') {
      const elements: readonly unknown[] = holder.elements
      const index = elements.indexOf(value)
      const shifted = holder.elements
        .slice(0, index)
        .some(element => element?.type === 'SpreadElement')
      keys.unshift(shifted ? undefined : String(index))
    } else if (!CONSTANT_SHAPES.has(holder.type)) return undefined
    value = holder
  }
}

const readFrom = (reference: Node): { readonly read: Node; readonly keys: readonly Key[] } => {
  const keys: Key[] = []
  let read = reference
  for (;;) {
    const member = parentOf(read)
    if (member?.type !== 'MemberExpression' || member.object !== read) return { read, keys }
    keys.push(staticKey(member.property, member.computed))
    read = member
  }
}

const mayRead = (read: readonly Key[], held: readonly Key[]): boolean =>
  read.every((key, depth) => key === undefined || held[depth] === undefined || key === held[depth])

const plugin = {
  meta: { name: 'dev' },
  rules: {
    'no-source-comments': {
      meta: {
        type: 'suggestion',
        schema: [],
        messages: {
          clarify:
            'Express intent in code; preserve architectural rationale in an ADR before removing this comment.',
          directive:
            'Lint rules cannot be disabled in source. Fix the reported problem; if a rule is wrong, ask the user before changing it in scripts/code-policy.ts.',
        },
      },
      createOnce(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type === 'Shebang') continue
              if (DIRECTIVE.test(comment.value))
                context.report({ loc: FILE_START, messageId: 'directive' })
              else context.report({ loc: comment.loc, messageId: 'clarify' })
            }
          },
        }
      },
    } satisfies Rule,
    'no-internal-terms': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          reword:
            'This text uses the dev-internal term "{{term}}", which agents and users reading dev\'s text do not know. Use this wording instead: {{wording}}. This rule has no allowlist.',
          leaveOut:
            'This text names "{{term}}", a skill, workflow or decision record the reader may not have. Leave it out. This rule has no allowlist.',
        },
      },
      createOnce(context) {
        const report = (node: NodeOf<'Literal'> | NodeOf<'TemplateLiteral'>, text: string) => {
          const found = internalTerm(text)
          if (found === undefined) return
          const { term, replacement } = found
          if (replacement.kind === 'leave-out')
            context.report({ node, messageId: 'leaveOut', data: { term } })
          else
            context.report({
              node,
              messageId: 'reword',
              data: { term, wording: replacement.wording },
            })
        }
        const checkWritten = (
          node: NodeOf<'Literal'> | NodeOf<'TemplateLiteral'>,
          text: string
        ) => {
          if (QUERY_LANGUAGE.test(text)) return
          if (MESSAGE_LABEL.test(text) || PROSE.test(text) || sentenceAround(node))
            return report(node, text)
          const held = constantHolding(node)
          if (
            held !== undefined &&
            context.sourceCode.getDeclaredVariables(held.constant).some(variable =>
              variable.references.some(reference => {
                const { read, keys } = readFrom(reference.identifier)
                return mayRead(keys, held.keys) && sentenceAround(read)
              })
            )
          )
            report(node, text)
        }
        return {
          Literal(node) {
            if (typeof node.value === 'string') checkWritten(node, node.value)
          },
          TemplateLiteral(node) {
            const text = written(node)
            if (node.expressions.length === 0) checkWritten(node, text)
            else if (PROSE.test(text) && !QUERY_LANGUAGE.test(text)) report(node, text)
          },
        }
      },
    } satisfies Rule,
    'no-fixed-sleep': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          fixedSleep:
            'This test waits a fixed time. Await the event that proves the state instead: a promise, an emitter event, a deferred, or waitFor/waitUntil from tests/wait.ts. To assert that something does not happen, use holdsFor from tests/wait.ts. Delay a fixture action with setTimeout(action, ms) or Effect.delay only when that timing is the behavior under test, such as a slow server or a timeout. A test that works only by giving the code time to reach a state it does not expose needs a redesign or removal; ask the user. This rule has no allowlist.',
        },
      },
      createOnce(context) {
        const delays = new Set<string>()
        const timerModules = new Set<string>()
        const schedulers = new Set<string>()
        const effects = new Set<string>()
        const isDelay = (callee: Call['callee']): boolean => {
          if (callee.type === 'Identifier') return delays.has(callee.name)
          const member = memberOf(callee)
          if (member === undefined) return false
          const [root, nested] = member.object
          if (root === undefined) return false
          if (nested === undefined)
            return (
              (timerModules.has(root) && member.property === 'setTimeout') ||
              (schedulers.has(root) && member.property === 'wait') ||
              (effects.has(root) && member.property === 'sleep')
            )
          return (
            (timerModules.has(root) && nested === 'scheduler' && member.property === 'wait') ||
            (effects.has(root) && nested === 'Effect' && member.property === 'sleep')
          )
        }
        return {
          before() {
            delays.clear()
            timerModules.clear()
            schedulers.clear()
            effects.clear()
            effects.add('Effect')
            return relative(context.cwd, context.filename) !== WAIT_MODULE
          },
          ImportDeclaration(node) {
            const source = node.source.value
            for (const specifier of node.specifiers) {
              const name = importedName(specifier)
              const local = specifier.local.name
              if (TIMER_MODULES.has(source)) {
                if (name === 'setTimeout') delays.add(local)
                else if (name === 'scheduler') schedulers.add(local)
                else if (name === undefined) timerModules.add(local)
              } else if (EFFECT_MODULES.has(source)) {
                if (name === 'sleep' && source === 'effect/Effect') delays.add(local)
                else if (name === undefined || name === 'Effect') effects.add(local)
              }
            }
          },
          CallExpression(node) {
            if (isDelay(node.callee)) context.report({ node, messageId: 'fixedSleep' })
          },
          NewExpression(node) {
            if (resolvesOnTimer(node)) context.report({ node, messageId: 'fixedSleep' })
          },
        }
      },
    } satisfies Rule,
  },
}

export default plugin
