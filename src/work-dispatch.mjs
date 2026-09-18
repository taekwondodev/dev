import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Dispatch profiles must be single objects; quota candidate arrays are unsupported'
    )
  }
  for (const key of Object.keys(value)) {
    if (!['harness', 'model', 'effort'].includes(key))
      throw new Error(`Unsupported dispatch field: ${key}`)
  }
  if (value.harness !== 'pi')
    throw new Error(`Unsupported harness: ${value.harness}; only pi is available`)
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) {
    throw new Error('Dispatch model must be a nonempty model identifier')
  }
  if (value.effort !== undefined && !EFFORTS.includes(value.effort)) {
    throw new Error(`Unsupported dispatch effort: ${value.effort}`)
  }
  return value
}

export function readDispatch() {
  const path = fileURLToPath(new URL('../config/crew-dispatch.json', import.meta.url))
  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read dispatch configuration at ${path}: ${error.message}`, {
      cause: error,
    })
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Invalid dispatch configuration')
  if (Object.keys(config).some(key => !['rules', 'default'].includes(key)))
    throw new Error('Dispatch supports only rules and default')
  if (config.rules !== undefined && !Array.isArray(config.rules))
    throw new Error('Dispatch rules must be an array')
  for (const rule of config.rules ?? []) {
    if (
      !rule ||
      typeof rule.when !== 'string' ||
      !rule.when.trim() ||
      Object.keys(rule).some(key => !['when', 'use', 'why'].includes(key)) ||
      (rule.why !== undefined && typeof rule.why !== 'string')
    )
      throw new Error('Invalid dispatch rule')
    validateProfile(rule.use)
  }
  if (config.default !== undefined) validateProfile(config.default)
  return {
    path,
    configured: true,
    rules: config.rules ?? [],
    default: config.default ?? { harness: 'pi' },
  }
}

export function resolveDispatch(input) {
  const config = readDispatch()
  let selected = config.default
  if (config.rules.length > 0 && input.rule === undefined) {
    throw new Error(
      'Read work dispatch, choose a rule index or "default", then pass that selection explicitly'
    )
  }
  if (input.rule !== undefined && input.rule !== 'default') {
    if (
      typeof input.rule !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(input.rule) ||
      !Number.isSafeInteger(Number(input.rule)) ||
      !config.rules[Number(input.rule)]
    )
      throw new Error('Invalid dispatch rule index')
    selected = config.rules[Number(input.rule)].use
  }
  return validateProfile({
    harness: input.harness ?? selected.harness,
    ...(selected.model === undefined ? {} : { model: selected.model }),
    ...(selected.effort === undefined ? {} : { effort: selected.effort }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  })
}

export function quotaExhausted(message) {
  return /insufficient_quota|quota.{0,40}(exceed|exhaust)|usage.limit|usage_limit|credit.balance|billing.hard.limit|subscription.{0,40}(limit|exhaust)/i.test(
    message ?? ''
  )
}
