export function qualityRuleSelection(ids: unknown, rules: Array<{ ruleId: string }>) {
  const available = new Set(rules.map(rule => rule.ruleId));
  const unique = [...new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])];
  return { valid: unique.filter(id => available.has(id)), unknown: unique.filter(id => !available.has(id)) };
}
