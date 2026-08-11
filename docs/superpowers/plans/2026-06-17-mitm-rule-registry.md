# MITM Rule Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a rule-group registry and admin controls so built-in and external MITM rule groups can be listed, enabled, and disabled while old external `rule.js` files keep working.

**Architecture:** Introduce `proxy/mitm/registry.js` as the only normalization and enabled-rule source. `proxy/proxy.js` will stop directly merging and iterating raw `Rule` objects, and will ask the registry for effective enabled rules before each proxy server starts. The admin server exposes rule metadata through `GET /api/rules`, and the React admin UI edits `config.rule_modules`.

**Tech Stack:** Node.js CommonJS, @bachi/anyproxy, Express 5, React 19 / CRA, existing `node:test`-style lightweight scripts using Node `assert`.

---

## File Structure

- Create: `proxy/mitm/registry.js`
  - Owns rule source loading, normalization, validation, regexp compilation, source override semantics, enabled filtering, and metadata output.
- Modify: `proxy/mitm/rule.js`
  - Keep existing callbacks and rule item shape, but wrap built-in groups with `name`, `description`, and `rules`.
- Modify: `proxy/proxy.js`
  - Replace global raw `Rule` mutation with registry rebuild and enabled-rule access.
  - Ensure initial startup and `LocalProxy.restart()` rebuild the registry before creating `AnyProxy.ProxyServer`.
  - Preserve callback `this` with `rule.callback.call(rule, ...)`.
  - Preserve `rule_modules` in the whitelisted `loadConfig()` return value.
  - Expose narrow test hooks for runtime rule filtering behavior.
- Modify: `server/express.js`
  - Add `GET /api/rules`.
- Modify: `src/App.js`
  - Fetch rule metadata.
  - Render "Rule 逻辑区块".
  - Update `config.rule_modules` on checkbox changes.
- Modify: `src/App.css`
  - Add compact rule-list styles consistent with existing admin form styling.
- Create: `test/mitm-registry-tests.js`
  - Pure Node assertions for registry normalization and filtering.
- Create: `test/mitm-runtime-tests.js`
  - Pure Node assertions for proxy-level consumers: MITM handler, response rules, host selection, and UA filtering.
- Modify: `package.json`
  - Add `test:registry` and `test:mitm-runtime` scripts and include them in a practical verification path.

## Task 1: Registry Unit Tests

**Files:**
- Create: `test/mitm-registry-tests.js`
- Modify: `package.json`

- [ ] **Step 1: Add a test script to `package.json`**

Add:

```json
"test:registry": "node test/mitm-registry-tests.js",
"test:mitm-runtime": "node test/mitm-runtime-tests.js"
```

Keep the existing `test:proxy` script unchanged.

- [ ] **Step 2: Write failing tests for normalization and enablement**

Create `test/mitm-registry-tests.js`:

```js
#!/usr/bin/env node

const assert = require('assert');
const {
  createRegistry,
  normalizeRuleExports
} = require('../proxy/mitm/registry');

function makeRule(host = 'example.com', regexp = '^https://example.com/') {
  return {
    type: 'beforeSendRequest',
    host,
    regexp,
    callback: async function() {
      return null;
    }
  };
}

function testOldFormatNormalizes() {
  const groups = normalizeRuleExports({
    MyRule: [makeRule()]
  }, { source: 'external:docker', defaultDescription: '外部自定义规则' });

  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].id, 'external:docker:MyRule');
  assert.strictEqual(groups[0].key, 'MyRule');
  assert.strictEqual(groups[0].name, 'MyRule');
  assert.strictEqual(groups[0].description, '外部自定义规则');
  assert.strictEqual(groups[0].rules.length, 1);
  assert.ok(groups[0].rules[0].compiledRegexp instanceof RegExp);
}

function testNewFormatNormalizes() {
  const groups = normalizeRuleExports({
    MyRule: {
      name: 'Custom Rule',
      description: 'Custom description',
      rules: [makeRule()]
    }
  }, { source: 'external:cli', defaultDescription: '外部自定义规则' });

  assert.strictEqual(groups[0].id, 'external:cli:MyRule');
  assert.strictEqual(groups[0].name, 'Custom Rule');
  assert.strictEqual(groups[0].description, 'Custom description');
}

function testInvalidItemsAreSkipped() {
  const groups = normalizeRuleExports({
    Broken: [
      makeRule('ok.example.com'),
      { type: 'beforeSendRequest', host: 'bad.example.com', regexp: '(', callback: async function() {} },
      { type: 'beforeSendRequest', host: 'bad.example.com', regexp: '^https://bad', callback: 'not-a-function' }
    ]
  }, { source: 'external:docker', defaultDescription: '外部自定义规则' });

  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].rules.length, 1);
  assert.strictEqual(groups[0].ruleCount, 1);
}

function testLegacyOverrideOrder() {
  const registry = createRegistry({
    builtinRules: { Same: [makeRule('builtin.example.com')] },
    cliRules: { Same: [makeRule('cli.example.com')] },
    dockerRules: { Same: [makeRule('docker.example.com')] },
    config: {}
  });

  const modules = registry.getRuleModules();
  assert.strictEqual(modules.length, 1);
  assert.strictEqual(modules[0].id, 'external:docker:Same');
  assert.strictEqual(registry.getEnabledRules()[0].host, 'docker.example.com');
}

function testExplicitFalseDisablesGroup() {
  const registry = createRegistry({
    builtinRules: { Youtube: [makeRule('youtubei.googleapis.com')] },
    config: { rule_modules: { 'builtin:Youtube': false } }
  });

  assert.deepStrictEqual(registry.getEnabledRules(), []);
  assert.strictEqual(registry.isBuiltinYoutubeEnabled(), false);
}

function testMissingConfigDefaultsEnabled() {
  const registry = createRegistry({
    builtinRules: { Youtube: [makeRule('youtubei.googleapis.com')] },
    config: {}
  });

  assert.strictEqual(registry.getEnabledRules().length, 1);
  assert.strictEqual(registry.isBuiltinYoutubeEnabled(), true);
}

[
  testOldFormatNormalizes,
  testNewFormatNormalizes,
  testInvalidItemsAreSkipped,
  testLegacyOverrideOrder,
  testExplicitFalseDisablesGroup,
  testMissingConfigDefaultsEnabled
].forEach((testFn) => {
  testFn();
  console.log(`PASS ${testFn.name}`);
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run:

```bash
npm run test:registry
```

Expected: FAIL with `Cannot find module '../proxy/mitm/registry'`.

- [ ] **Step 4: Commit the failing test**

```bash
git add package.json test/mitm-registry-tests.js
git commit -m "test: add mitm registry coverage"
```

## Task 2: Registry Implementation

**Files:**
- Create: `proxy/mitm/registry.js`
- Modify: `proxy/mitm/rule.js`
- Test: `test/mitm-registry-tests.js`

- [ ] **Step 1: Implement `proxy/mitm/registry.js`**

Add these exported functions:

```js
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
```

Adjust if lint/runtime reveals unused imports or path issues.

- [ ] **Step 2: Refactor built-in `proxy/mitm/rule.js` metadata**

Keep `hijackResponse()` and callbacks unchanged. Replace the export shape:

```js
module.exports = {
  Youtube: {
    name: 'YouTube 广告拦截',
    description: '拦截 YouTube App 视频广告（仅对 App 生效，浏览器不处理）',
    rules: [
      // existing Youtube rule items
    ]
  },
  YDCD: {
    name: '有道词典 VIP',
    description: '解锁有道词典 VIP 会员功能',
    rules: [
      // existing YDCD rule items
    ]
  }
};
```

Do not rewrite the callback logic in this task.

- [ ] **Step 3: Run registry tests**

Run:

```bash
npm run test:registry
```

Expected: all `PASS ...` lines and exit code 0.

- [ ] **Step 4: Commit registry implementation**

```bash
git add proxy/mitm/registry.js proxy/mitm/rule.js
git commit -m "feat: add mitm rule registry"
```

## Task 3: Proxy Runtime Integration

**Files:**
- Modify: `proxy/proxy.js`
- Create: `test/mitm-runtime-tests.js`
- Test: `test/mitm-registry-tests.js`

- [ ] **Step 1: Replace raw `Rule` imports with the registry**

At the top of `proxy/proxy.js`, replace:

```js
var   Rule = require("./mitm/rule.js");
```

with:

```js
const mitmRegistry = require("./mitm/registry.js");
let ruleRegistry = mitmRegistry.createRegistry({ config: {} });
let cliRulePath = null;
```

- [ ] **Step 2: Replace `preCompileRuleRegexp()`**

Remove the old raw `Rule` mutation function and add:

```js
function getEnabledMitmRules() {
  return ruleRegistry.getEnabledRules();
}

function isBuiltinYoutubeMitmEnabled() {
  return enable_mitm === "1" && ruleRegistry.isBuiltinYoutubeEnabled();
}
```

The registry now compiles regexps. Keeping the `enable_mitm` guard here prevents UA-filter side effects when global MITM is off, without making the registry aware of proxy-global state.

- [ ] **Step 3: Change CLI and Docker loading to capture paths**

Replace `loadGlobalConfigFile()` body with path capture:

```js
async function loadGlobalConfigFile() {
  cliRulePath = await _fs.getGlobalConfigFile();
  await _fs.clearGlobalConfigFile();
}
```

Replace `loadDockerMountedConfigFile()` with a helper that returns the mounted path or `null`:

```js
async function getDockerMountedRulePath() {
  const rulePath = path.join(__dirname, '../config/rule.js');
  return await fileExists(rulePath) ? rulePath : null;
}
```

Remove the old `loadDockerMountedConfigFile()` function after replacing it. Docker rule loading now belongs to `rebuildRuleRegistry()`.

- [ ] **Step 4: Add registry rebuild function**

Add near config loading helpers:

```js
async function rebuildRuleRegistry(config) {
  const dockerRulePath = await getDockerMountedRulePath();
  ruleRegistry = mitmRegistry.createRegistryFromFiles({
    config,
    cliRulePath,
    dockerRulePath
  });
}
```

- [ ] **Step 5: Preserve `rule_modules` in config loading**

In `loadConfig()`, add `rule_modules` to the default `config` object:

```js
rule_modules: {}
```

After `enable_mitm` is loaded, copy persisted rule module state:

```js
config.rule_modules = loadedConfig.rule_modules || {};
```

When creating a default `config.json`, include:

```js
rule_modules: {}
```

This is required because `loadConfig()` reconstructs a whitelist config object. Without this, disabled rule groups saved by the UI will be dropped before the registry sees them.

- [ ] **Step 6: Rebuild before each proxy server start**

In `start(callback)`, before `getAnyProxyOptions()` or `new AnyProxy.ProxyServer(...)` is called, load config and rebuild registry:

```js
const config = await loadConfig();
await rebuildRuleRegistry(config);
```

Do this in the path used by both initial start and `restart()`. Keep `loadGlobalConfigFile()` only in `init()` so CLI paths remain one-shot.

In `init()`, remove the old calls that are no longer valid:

```js
await loadDockerMountedConfigFile();
preCompileRuleRegexp();
```

`loadDockerMountedConfigFile()` has been replaced by `getDockerMountedRulePath()` inside `rebuildRuleRegistry()`, and regexp compilation now happens in `registry.js`.

- [ ] **Step 7: Update runtime rule consumers**

In `MITMHandler()` replace `Object.keys(Rule)` flattening with:

```js
const Ms = getEnabledMitmRules();
```

When invoking callbacks, use:

```js
responseResult = await item.callback.call(item, url, request, response);
```

In `getResponseRules()`, iterate `getEnabledMitmRules()`.

In `shouldMitm()`, iterate `getEnabledMitmRules()`.

- [ ] **Step 8: Bind UA filter to effective built-in YouTube**

Replace:

```js
if (uaFilter.match(requestOptions.headers, host)) {
```

with:

```js
if (isBuiltinYoutubeMitmEnabled() && uaFilter.match(requestOptions.headers, host)) {
```

- [ ] **Step 9: Expose read-only rule modules from LocalProxy**

Add to `module.exports`:

```js
getRuleModules: async function() {
  return ruleRegistry.getRuleModules();
}
```

This returns current running-state rule metadata without calling `loadConfig()` and without rebuilding the live registry from a GET request. The UI uses `config.rule_modules` for checkbox state, so metadata does not need to reread config on every request. New Docker rule files and changed enablement take runtime effect after proxy restart, matching the restart-oriented behavior.

- [ ] **Step 10: Add proxy runtime test hooks**

Add a private test export under `module.exports`:

```js
_test: {
  setRuleRegistryForTest(nextRegistry) {
    ruleRegistry = nextRegistry;
  },
  setEnableMitmForTest(nextValue) {
    enable_mitm = nextValue;
  },
  getResponseRules,
  shouldMitm,
  shouldBypassByUa(headers, host) {
    return isBuiltinYoutubeMitmEnabled() && uaFilter.match(headers, host);
  },
  async runMITMHandler(type, url, request, response) {
    return MITMHandler(type, url, request, response);
  }
}
```

Keep these hooks narrow. Only `setRuleRegistryForTest()` mutates state, and only inside the Node test process.

- [ ] **Step 11: Create proxy runtime tests**

Create `test/mitm-runtime-tests.js`:

```js
#!/usr/bin/env node

const assert = require('assert');
const mitmRegistry = require('../proxy/mitm/registry');
const LocalProxy = require('../proxy/proxy');

function makeRule(host = 'example.com', regexp = '^https://example.com/path', type = 'beforeSendRequest') {
  return {
    type,
    host,
    regexp,
    callback: async function() {
      return {
        response: {
          statusCode: 204,
          header: { 'X-Rule-Regexp': this.regexp },
          body: Buffer.alloc(0)
        }
      };
    }
  };
}

function setRegistry(config) {
  const registry = mitmRegistry.createRegistry({
    builtinRules: {
      Youtube: [makeRule('youtubei.googleapis.com', '^https://youtubei.googleapis.com/path')],
      Custom: [
        makeRule('example.com'),
        makeRule('response.example.com', '^https://response.example.com/path', 'beforeSendResponse')
      ]
    },
    config
  });
  LocalProxy._test.setRuleRegistryForTest(registry);
}

async function testDisabledRulesDoNotMitmOrBufferOrRewrite() {
  setRegistry({ rule_modules: { 'builtin:Custom': false } });

  assert.strictEqual(LocalProxy._test.shouldMitm('example.com'), false);
  assert.strictEqual(LocalProxy._test.shouldMitm('response.example.com'), false);
  assert.deepStrictEqual(LocalProxy._test.getResponseRules(), []);

  const result = await LocalProxy._test.runMITMHandler(
    'beforeSendRequest',
    'https://example.com/path',
    {},
    {}
  );
  assert.strictEqual(result, null);
}

async function testEnabledRulesRewriteAndPreserveThis() {
  setRegistry({});

  assert.strictEqual(LocalProxy._test.shouldMitm('example.com'), true);
  assert.strictEqual(LocalProxy._test.shouldMitm('response.example.com'), true);
  assert.deepStrictEqual(LocalProxy._test.getResponseRules(), [{
    type: 'beforeSendResponse',
    host: 'response.example.com',
    regexp: '^https://response.example.com/path'
  }]);

  const result = await LocalProxy._test.runMITMHandler(
    'beforeSendRequest',
    'https://example.com/path',
    {},
    {}
  );
  assert.strictEqual(result.response.statusCode, 204);
  assert.strictEqual(result.response.header['X-Rule-Regexp'], '^https://example.com/path');
}

function testYoutubeUaFilterRequiresEffectiveBuiltinYoutube() {
  LocalProxy._test.setEnableMitmForTest("1");
  setRegistry({ rule_modules: { 'builtin:Youtube': false } });
  assert.strictEqual(LocalProxy._test.shouldBypassByUa({ 'User-Agent': 'Mozilla/5.0' }, 'youtube.com'), false);

  const shadowRegistry = mitmRegistry.createRegistry({
    builtinRules: { Youtube: [makeRule('youtubei.googleapis.com')] },
    cliRules: { Youtube: [makeRule('youtubei.googleapis.com')] },
    config: {}
  });
  LocalProxy._test.setRuleRegistryForTest(shadowRegistry);
  assert.strictEqual(LocalProxy._test.shouldBypassByUa({ 'User-Agent': 'Mozilla/5.0' }, 'youtube.com'), false);

  setRegistry({});
  assert.strictEqual(LocalProxy._test.shouldBypassByUa({ 'User-Agent': 'Mozilla/5.0' }, 'youtube.com'), true);

  LocalProxy._test.setEnableMitmForTest("0");
  assert.strictEqual(LocalProxy._test.shouldBypassByUa({ 'User-Agent': 'Mozilla/5.0' }, 'youtube.com'), false);
  LocalProxy._test.setEnableMitmForTest("1");
}

(async () => {
  await testDisabledRulesDoNotMitmOrBufferOrRewrite();
  console.log('PASS testDisabledRulesDoNotMitmOrBufferOrRewrite');
  await testEnabledRulesRewriteAndPreserveThis();
  console.log('PASS testEnabledRulesRewriteAndPreserveThis');
  testYoutubeUaFilterRequiresEffectiveBuiltinYoutube();
  console.log('PASS testYoutubeUaFilterRequiresEffectiveBuiltinYoutube');
})();
```

- [ ] **Step 12: Run registry/runtime tests and syntax check**

Run:

```bash
npm run test:registry
npm run test:mitm-runtime
node -c proxy/proxy.js
```

Expected: registry tests pass, runtime tests pass, syntax check exits 0.

- [ ] **Step 13: Commit runtime integration**

```bash
git add package.json proxy/proxy.js test/mitm-runtime-tests.js
git commit -m "feat: integrate mitm registry with proxy runtime"
```

## Task 4: Admin Rules API

**Files:**
- Modify: `server/express.js`

- [ ] **Step 1: Add `GET /api/rules`**

After `GET /api/config`, add:

```js
app.get('/api/rules', async (req, res) => {
  try {
    const rules = await LocalProxy.getRuleModules();
    res.status(200).json(rules);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read rule modules: ' + error.message });
  }
});
```

- [ ] **Step 2: Run syntax checks**

Run:

```bash
node -c server/express.js
node -c proxy/proxy.js
```

Expected: both exit 0.

- [ ] **Step 3: Commit API change**

```bash
git add server/express.js
git commit -m "feat: expose mitm rule modules api"
```

## Task 5: Admin UI Rule Logic Block

**Files:**
- Modify: `src/App.js`
- Modify: `src/App.css`

- [ ] **Step 1: Add React state for rule modules**

Near existing state declarations in `src/App.js`, add:

```js
const [ruleModules, setRuleModules] = useState([]);
```

- [ ] **Step 2: Fetch rules on mount**

In `useEffect()`, add `fetchRuleModules();`.

Add:

```js
const fetchRuleModules = async () => {
  try {
    const response = await fetch('/api/rules');
    if (response.ok) {
      const data = await response.json();
      setRuleModules(data);
    }
  } catch (error) {
    showToast('获取 Rule 逻辑失败: ' + error.message, 'error');
  }
};
```

- [ ] **Step 3: Add checkbox update helper**

Add:

```js
const updateRuleModuleEnabled = (id, enabled) => {
  setRuleModules(ruleModules.map((rule) => (
    rule.id === id ? { ...rule, enabled } : rule
  )));
  setConfig({
    ...config,
    rule_modules: {
      ...(config.rule_modules || {}),
      [id]: enabled
    }
  });
};
```

- [ ] **Step 4: Render "Rule 逻辑区块" below MITM select**

Below the `HTTPS MITM 解密` setting row, add:

```jsx
<div className="rule-module-block">
  <div className="rule-module-header">
    <h3>Rule 逻辑区块</h3>
    {(config.enable_mitm || "1") !== "1" && (
      <span className="rule-module-disabled-note">MITM 关闭时规则不会生效</span>
    )}
  </div>
  <div className="rule-module-list">
    {ruleModules.length === 0 ? (
      <div className="help-text">暂无已加载 Rule 逻辑</div>
    ) : ruleModules.map((rule) => (
      <label className="rule-module-item" key={rule.id}>
        <input
          type="checkbox"
          checked={config.rule_modules?.[rule.id] !== false}
          disabled={(config.enable_mitm || "1") !== "1"}
          onChange={(e) => updateRuleModuleEnabled(rule.id, e.target.checked)}
        />
        <span className="rule-module-main">
          <span className="rule-module-title">
            {rule.name}
            <span className="rule-module-source">{rule.source}</span>
            <span className="rule-module-count">{rule.ruleCount} 条</span>
          </span>
          <span className="rule-module-description">{rule.description}</span>
        </span>
      </label>
    ))}
  </div>
</div>
```

- [ ] **Step 5: Add CSS**

Add styles to `src/App.css`:

```css
.rule-module-block {
  width: 100%;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #e1e5e9;
  border-radius: 6px;
  background: #fafbfc;
}

.rule-module-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.rule-module-header h3 {
  margin: 0;
}

.rule-module-disabled-note {
  color: #8a6d3b;
  font-size: 13px;
}

.rule-module-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule-module-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px;
  border-radius: 6px;
  background: #fff;
}

.rule-module-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.rule-module-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.rule-module-source,
.rule-module-count {
  font-size: 12px;
  color: #5f6b7a;
  font-weight: 400;
}

.rule-module-description {
  color: #5f6b7a;
  font-size: 13px;
  line-height: 1.4;
}
```

Adjust colors if the existing CSS nearby uses different neutral tokens.

- [ ] **Step 6: Run frontend build**

Run:

```bash
npm run build
```

Expected: build succeeds. If it fails due to CI environment warnings, capture exact output and fix real React syntax issues.

- [ ] **Step 7: Commit UI change**

```bash
git add src/App.js src/App.css
git commit -m "feat: add admin rule module controls"
```

## Task 6: End-to-End Verification

**Files:**
- No planned source edits unless verification exposes bugs.

- [ ] **Step 1: Run registry and runtime tests**

Run:

```bash
npm run test:registry
npm run test:mitm-runtime
```

Expected: all tests pass.

- [ ] **Step 2: Run proxy syntax checks**

Run:

```bash
node -c proxy/mitm/registry.js
node -c proxy/mitm/rule.js
node -c proxy/proxy.js
node -c server/express.js
```

Expected: all exit 0.

- [ ] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Run proxy integration smoke tests if ports are available**

Run:

```bash
npm run test:proxy -- --skip-external --auto-start
```

Expected: no failed test items. If local ports 8001 or 8002 are already occupied, record that and run the syntax/build tests as the minimum verification.

- [ ] **Step 5: Manual admin API smoke check**

Start the app if it is not running:

```bash
npm run start
```

Then request:

```bash
curl -fsSL http://127.0.0.1:8003/api/rules
```

Expected: JSON array containing at least `builtin:Youtube` and `builtin:YDCD`, with `enabled: true` unless disabled in `config.json`.

- [ ] **Step 6: Manual UI smoke check**

Open:

```txt
http://127.0.0.1:8003
```

Expected:

- The "Rule 逻辑区块" appears below "HTTPS MITM 解密".
- Built-in rules are shown with source `builtin`.
- Unchecking a rule and saving writes `config.rule_modules["builtin:..."] = false`.
- Restarting the proxy keeps the checkbox state.

- [ ] **Step 7: Final commit if verification fixes were needed**

Only if fixes were made during verification:

```bash
git add <changed-files>
git commit -m "fix: stabilize mitm rule registry integration"
```

## Implementation Notes

- Do not add per-rule-item IDs in this implementation.
- Do not make CLI external rule paths persistent; keep the existing one-shot behavior.
- Preserve legacy shadowing by top-level key: built-in < CLI < Docker.
- Keep disabled groups out of `MITMHandler()`, `getResponseRules()`, and `shouldMitm()`.
- Keep YouTube UA filter active only when global `enable_mitm` is `"1"` and the effective `Youtube` group is `builtin:Youtube` and enabled.
- Keep user `block_hosts` behavior separate from `rule_modules`.
- Preserve `rule_modules` in `loadConfig()`; the proxy runtime must see the same enabled state that the UI saves.
- Do not call `loadConfig()` or rebuild the live runtime registry from `GET /api/rules`; return current `ruleRegistry.getRuleModules()` and apply runtime changes only on proxy start/restart.
