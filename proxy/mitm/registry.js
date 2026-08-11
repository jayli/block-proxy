// proxy/mitm/registry.js
// MITM 规则注册表：负责加载、规范化、编译、覆盖、启停控制

const path = require('path');

function safeRequire(filePath, label) {
  if (!filePath) return null;
  try {
    delete require.cache[require.resolve(filePath)];
    return require(filePath);
  } catch (error) {
    console.error(`[MITM Registry] Failed to load ${label || filePath}:`, error.message);
    return null;
  }
}

function compileRule(rule, context) {
  if (!rule || typeof rule !== 'object') return null;
  if (!rule.type || !rule.host || !rule.regexp || typeof rule.callback !== 'function') {
    console.error(`[MITM Registry] Invalid rule item in ${context}: missing type/host/regexp/function callback`);
    return null;
  }

  try {
    return {
      ...rule,
      compiledRegexp: new RegExp(rule.regexp)
    };
  } catch (error) {
    console.error(`[MITM Registry] Invalid regexp in ${context}: "${rule.regexp}"`, error.message);
    return null;
  }
}

function normalizeRuleExports(ruleExports, options) {
  const source = options.source;
  const defaultDescription = options.defaultDescription || '';
  const groups = [];

  if (!ruleExports || typeof ruleExports !== 'object') return groups;

  Object.keys(ruleExports).forEach((key) => {
    const value = ruleExports[key];
    const isArrayFormat = Array.isArray(value);
    const isObjectFormat = value && typeof value === 'object' && Array.isArray(value.rules);

    if (!isArrayFormat && !isObjectFormat) {
      console.error(`[MITM Registry] Invalid rule group ${source}:${key}: expected array or { rules: [] }`);
      return;
    }

    const rules = isArrayFormat ? value : value.rules;
    const validRules = rules
      .map((rule) => compileRule(rule, `${source}:${key}`))
      .filter(Boolean);

    groups.push({
      id: `${source}:${key}`,
      source,
      key,
      name: isObjectFormat && value.name ? value.name : key,
      description: isObjectFormat && value.description ? value.description : defaultDescription,
      rules: validRules,
      ruleCount: validRules.length
    });
  });

  return groups;
}

function createRegistry(options = {}) {
  const config = options.config || {};
  const sources = [
    { source: 'builtin', rules: options.builtinRules || {}, description: '内置规则' },
    { source: 'external:cli', rules: options.cliRules || {}, description: '外部自定义规则' },
    { source: 'external:docker', rules: options.dockerRules || {}, description: '外部自定义规则' }
  ];
  const effectiveByKey = new Map();

  sources.forEach((entry) => {
    normalizeRuleExports(entry.rules, {
      source: entry.source,
      defaultDescription: entry.description
    }).forEach((group) => {
      effectiveByKey.set(group.key, group);
    });
  });

  const effectiveGroups = Array.from(effectiveByKey.values());

  function isGroupEnabled(group) {
    return config.rule_modules?.[group.id] !== false;
  }

  function getEnabledGroups() {
    return effectiveGroups.filter(isGroupEnabled);
  }

  return {
    getRuleModules() {
      return effectiveGroups.map((group) => ({
        id: group.id,
        source: group.source,
        key: group.key,
        name: group.name,
        description: group.description,
        enabled: isGroupEnabled(group),
        ruleCount: group.ruleCount
      }));
    },
    getEnabledGroups,
    getEnabledRules() {
      return getEnabledGroups().flatMap((group) => group.rules);
    },
    isBuiltinYoutubeEnabled() {
      const group = effectiveByKey.get('Youtube');
      return !!group && group.id === 'builtin:Youtube' && isGroupEnabled(group);
    }
  };
}

function createRegistryFromFiles(options = {}) {
  const builtinRules = options.builtinRules || require('./rule.js');
  const cliRules = options.cliRulePath ? safeRequire(path.resolve(options.cliRulePath), 'CLI rule.js') : null;
  const dockerRules = options.dockerRulePath ? safeRequire(path.resolve(options.dockerRulePath), 'Docker rule.js') : null;

  return createRegistry({
    builtinRules,
    cliRules,
    dockerRules,
    config: options.config
  });
}

module.exports = {
  createRegistry,
  createRegistryFromFiles,
  normalizeRuleExports
};
