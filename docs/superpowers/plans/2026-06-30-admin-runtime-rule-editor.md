# Admin Runtime Rule Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 8003 admin tab for editing an isolated runtime `rule.js` copy, with validation, save, backups, restore, and predictable CLI/Docker startup import behavior.

**Architecture:** Introduce a focused runtime rule manager that owns `config/runtime-rule.js`, metadata, import policy, validation, backups, and restore. The proxy registry loads built-in rules plus the runtime rule file only; CLI and Docker files become startup import sources. Express exposes thin authenticated APIs, and React adds a "自定义 rule" tab backed by those APIs.

**Tech Stack:** Node.js CommonJS, Express 5, React 19 / CRA, existing MITM registry, Node `assert` test scripts, filesystem-backed runtime config.

---

## File Structure

- Create: `proxy/mitm/runtimeRule.js`
  - Owns runtime rule paths, metadata defaults, source import, syntax validation, structural validation, atomic save, backup listing, backup creation, and restore.
- Modify: `proxy/mitm/registry.js`
  - Add `runtimeRulePath` support in `createRegistryFromFiles()`.
  - Keep old `cliRulePath` and `dockerRulePath` support for tests/backward compatibility during migration, but proxy integration should pass only `runtimeRulePath`.
- Modify: `proxy/proxy.js`
  - Replace direct CLI/Docker registry loading with startup import into `runtime-rule.js`.
  - Keep `loadGlobalConfigFile()` as the one-shot CLI path capture.
  - Call runtime rule manager during `LocalProxy.init()` before `start()`.
  - Rebuild registry from `runtimeRulePath` on initial start and admin restart.
- Modify: `server/express.js`
  - Add authenticated custom-rule APIs.
  - Validate runtime rule before `/api/restart`.
- Modify: `src/App.js`
  - Add "自定义 rule" tab after "路由表".
  - Fetch, edit, validate, save, list backups, restore, and restart.
- Modify: `src/App.css`
  - Add compact code editor, toolbar, validation, and backup list styles consistent with current admin UI.
- Create: `test/runtime-rule-tests.js`
  - Pure Node tests for import policy, validation, save, backup, restore, and source isolation.
- Modify: `test/mitm-registry-tests.js`
  - Add runtime rule path loading coverage.
- Modify: `package.json`
  - Add `test:runtime-rule` and include it in the manual verification path.
- Modify: `README.md`, `Useage.md`, `wiki.md`
  - Document the startup import model and admin editor behavior.

## Task 1: Runtime Rule Manager Failing Tests

**Files:**
- Create: `test/runtime-rule-tests.js`
- Modify: `package.json`

- [ ] **Step 1: Add the test script**

Modify `package.json` scripts:

```json
"test:runtime-rule": "node test/runtime-rule-tests.js"
```

- [ ] **Step 2: Write failing tests for import policy and file isolation**

Create `test/runtime-rule-tests.js`:

```js
#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimeRule = require('../proxy/mitm/runtimeRule');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bp-runtime-rule-'));
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function makeSource(host) {
  return `module.exports = { MyRule: [{ type: "beforeSendRequest", host: "${host}", regexp: "^https://", callback: async function(){ return null; } }] };`;
}

async function testCreatesEmptyRuntimeRuleWithoutSource() {
  const root = tempRoot();
  const paths = runtimeRule.createPaths(root);

  const result = await runtimeRule.prepareRuntimeRule({
    paths,
    cliRulePath: null,
    dockerRulePath: null
  });

  assert.strictEqual(result.last_import_source, 'empty');
  assert.strictEqual(read(paths.runtimeRulePath), 'module.exports = {};\n');
}

async function testDockerImportWinsOverCli() {
  const root = tempRoot();
  const paths = runtimeRule.createPaths(root);
  const cliPath = path.join(root, 'cli-rule.js');
  const dockerPath = paths.dockerRulePath;
  write(cliPath, makeSource('cli.example.com'));
  write(dockerPath, makeSource('docker.example.com'));

  const result = await runtimeRule.prepareRuntimeRule({
    paths,
    cliRulePath: cliPath,
    dockerRulePath: dockerPath
  });

  assert.strictEqual(result.last_import_source, 'docker');
  assert.ok(read(paths.runtimeRulePath).includes('docker.example.com'));
  assert.ok(read(cliPath).includes('cli.example.com'));
  assert.ok(read(dockerPath).includes('docker.example.com'));
}

async function testPreferRuntimeKeepsExistingRule() {
  const root = tempRoot();
  const paths = runtimeRule.createPaths(root);
  write(paths.runtimeRulePath, makeSource('admin.example.com'));
  await runtimeRule.writeMeta(paths, { prefer_runtime_rule: true });
  write(paths.dockerRulePath, makeSource('docker.example.com'));

  const result = await runtimeRule.prepareRuntimeRule({
    paths,
    cliRulePath: null,
    dockerRulePath: paths.dockerRulePath
  });

  assert.strictEqual(result.last_import_source, 'runtime');
  assert.ok(read(paths.runtimeRulePath).includes('admin.example.com'));
}

async function testRejectsSyntaxInvalidSaveWithoutOverwrite() {
  const root = tempRoot();
  const paths = runtimeRule.createPaths(root);
  write(paths.runtimeRulePath, makeSource('good.example.com'));

  await assert.rejects(
    () => runtimeRule.saveRuntimeRule(paths, {
      source: 'module.exports = {',
      preferRuntimeRule: true
    }),
    /syntax/i
  );

  assert.ok(read(paths.runtimeRulePath).includes('good.example.com'));
}

async function testSaveCreatesBackupAndRestoreWorks() {
  const root = tempRoot();
  const paths = runtimeRule.createPaths(root);
  write(paths.runtimeRulePath, makeSource('old.example.com'));

  await runtimeRule.saveRuntimeRule(paths, {
    source: makeSource('new.example.com'),
    preferRuntimeRule: true
  });

  const backups = await runtimeRule.listBackups(paths);
  assert.strictEqual(backups.length, 1);
  assert.ok(read(paths.runtimeRulePath).includes('new.example.com'));

  await runtimeRule.restoreBackup(paths, backups[0].id);
  assert.ok(read(paths.runtimeRulePath).includes('old.example.com'));
}

(async () => {
  for (const testFn of [
    testCreatesEmptyRuntimeRuleWithoutSource,
    testDockerImportWinsOverCli,
    testPreferRuntimeKeepsExistingRule,
    testRejectsSyntaxInvalidSaveWithoutOverwrite,
    testSaveCreatesBackupAndRestoreWorks
  ]) {
    await testFn();
    console.log(`PASS ${testFn.name}`);
  }
})();
```

- [ ] **Step 3: Run the failing test**

Run:

```bash
npm run test:runtime-rule
```

Expected: FAIL with `Cannot find module '../proxy/mitm/runtimeRule'`.

- [ ] **Step 4: Commit the failing test**

```bash
git add package.json test/runtime-rule-tests.js
git commit -m "test: add runtime rule manager coverage"
```

## Task 2: Runtime Rule Manager Implementation

**Files:**
- Create: `proxy/mitm/runtimeRule.js`
- Test: `test/runtime-rule-tests.js`

- [ ] **Step 1: Implement paths, metadata, and hashing**

Create `proxy/mitm/runtimeRule.js` with these exported functions:

```js
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const EMPTY_RULE = 'module.exports = {};\n';
const DEFAULT_META = {
  prefer_runtime_rule: false,
  last_import_source: 'empty',
  last_import_path: '',
  last_import_hash: '',
  last_saved_at: '',
  last_saved_by: 'startup'
};

function createPaths(rootDir = path.join(__dirname, '../../config')) {
  return {
    configDir: rootDir,
    dockerRulePath: path.join(rootDir, 'rule.js'),
    runtimeRulePath: path.join(rootDir, 'runtime-rule.js'),
    metaPath: path.join(rootDir, 'runtime-rule-meta.json'),
    backupDir: path.join(rootDir, 'rule-backups')
  };
}

function ensureDirs(paths) {
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.backupDir, { recursive: true });
}

function ensureRuntimeRule(paths) {
  ensureDirs(paths);
  if (!fs.existsSync(paths.runtimeRulePath)) {
    fs.writeFileSync(paths.runtimeRulePath, EMPTY_RULE, 'utf8');
  }
}

function hashContent(source) {
  return `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`;
}
```

- [ ] **Step 2: Implement syntax validation**

Add:

```js
function validateSyntax(source) {
  try {
    new vm.Script(source, { filename: 'runtime-rule.js' });
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [`Syntax error: ${error.message}`] };
  }
}

function assertSyntax(source) {
  const result = validateSyntax(source);
  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }
}
```

- [ ] **Step 3: Implement structural validation**

Add validation that uses the existing registry normalizer on a temporary module file. This may execute top-level code in the rule module, matching the existing `-c rule.js` trust model; it must not overwrite the active runtime file.

```js
function validateStructure(source) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-rule-validate-'));
  const tempPath = path.join(tempRoot, 'rule.js');
  try {
    fs.writeFileSync(tempPath, source, 'utf8');
    delete require.cache[require.resolve(tempPath)];
    const exportsValue = require(tempPath);
    const registry = require('./registry.js');
    const groups = registry.normalizeRuleExports(exportsValue, {
      source: 'external:runtime',
      defaultDescription: '后台自定义规则'
    });
    return {
      ok: true,
      warnings: groups.filter((group) => group.ruleCount === 0).map((group) => `Rule group has no valid rules: ${group.key}`),
      groups: groups.map((group) => ({ id: group.id, key: group.key, ruleCount: group.ruleCount }))
    };
  } catch (error) {
    return { ok: false, warnings: [], errors: [`Rule module error: ${error.message}`] };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateSource(source) {
  const syntax = validateSyntax(source);
  if (!syntax.ok) return syntax;
  return validateStructure(source);
}
```

- [ ] **Step 4: Implement metadata IO**

Add `readMeta(paths)` and `writeMeta(paths, patch)`:

```js
function readMeta(paths) {
  try {
    return { ...DEFAULT_META, ...JSON.parse(fs.readFileSync(paths.metaPath, 'utf8')) };
  } catch {
    return { ...DEFAULT_META };
  }
}

async function writeMeta(paths, patch) {
  ensureDirs(paths);
  const next = { ...readMeta(paths), ...patch };
  fs.writeFileSync(paths.metaPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
```

- [ ] **Step 5: Implement startup import**

Add `prepareRuntimeRule({ paths, cliRulePath, dockerRulePath })`:

```js
async function prepareRuntimeRule({ paths = createPaths(), cliRulePath = null, dockerRulePath = null } = {}) {
  ensureDirs(paths);
  const meta = readMeta(paths);

  if (meta.prefer_runtime_rule === true) {
    ensureRuntimeRule(paths);
    return writeMeta(paths, {
      last_import_source: 'runtime',
      last_import_path: '',
      last_import_hash: hashContent(fs.readFileSync(paths.runtimeRulePath, 'utf8')),
      last_saved_at: new Date().toISOString(),
      last_saved_by: 'startup'
    });
  }

  const dockerPath = dockerRulePath || paths.dockerRulePath;
  let sourcePath = null;
  let source = 'empty';

  if (dockerPath && fs.existsSync(dockerPath)) {
    sourcePath = dockerPath;
    source = 'docker';
  } else if (cliRulePath && fs.existsSync(cliRulePath)) {
    sourcePath = cliRulePath;
    source = 'cli';
  }

  let createdEmpty = false;
  if (sourcePath) {
    const content = fs.readFileSync(sourcePath, 'utf8');
    assertSyntax(content);
    fs.writeFileSync(paths.runtimeRulePath, content, 'utf8');
  } else if (!fs.existsSync(paths.runtimeRulePath)) {
    fs.writeFileSync(paths.runtimeRulePath, EMPTY_RULE, 'utf8');
    createdEmpty = true;
  }

  const content = fs.readFileSync(paths.runtimeRulePath, 'utf8');
  return writeMeta(paths, {
    last_import_source: sourcePath ? source : (createdEmpty ? 'empty' : 'runtime'),
    last_import_path: sourcePath || '',
    last_import_hash: hashContent(content),
    last_saved_at: new Date().toISOString(),
    last_saved_by: 'startup'
  });
}
```

- [ ] **Step 6: Implement save, backups, listing, and restore**

Add:

```js
function makeBackupId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
}

function createBackup(paths) {
  ensureDirs(paths);
  if (!fs.existsSync(paths.runtimeRulePath)) return null;
  const id = makeBackupId();
  const ruleBackupPath = path.join(paths.backupDir, `${id}-rule.js`);
  const metaBackupPath = path.join(paths.backupDir, `${id}-meta.json`);
  fs.copyFileSync(paths.runtimeRulePath, ruleBackupPath);
  fs.writeFileSync(metaBackupPath, JSON.stringify(readMeta(paths), null, 2), 'utf8');
  return id;
}

async function listBackups(paths = createPaths()) {
  ensureDirs(paths);
  return fs.readdirSync(paths.backupDir)
    .filter((name) => name.endsWith('-rule.js'))
    .sort()
    .reverse()
    .map((name) => {
      const id = name.replace(/-rule\.js$/, '');
      const filePath = path.join(paths.backupDir, name);
      const metaPath = path.join(paths.backupDir, `${id}-meta.json`);
      const stat = fs.statSync(filePath);
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {}
      return {
        id,
        created_at: stat.mtime.toISOString(),
        source: meta.last_import_source || '',
        hash: hashContent(fs.readFileSync(filePath, 'utf8')),
        size: stat.size
      };
    });
}

async function saveRuntimeRule(paths = createPaths(), { source, preferRuntimeRule }) {
  const validation = validateSource(source);
  if (!validation.ok) {
    throw new Error((validation.errors || ['Invalid rule source']).join('\n'));
  }
  createBackup(paths);
  const tempPath = `${paths.runtimeRulePath}.tmp`;
  fs.writeFileSync(tempPath, source, 'utf8');
  fs.renameSync(tempPath, paths.runtimeRulePath);
  return writeMeta(paths, {
    prefer_runtime_rule: !!preferRuntimeRule,
    last_import_source: 'admin',
    last_import_path: '',
    last_import_hash: hashContent(source),
    last_saved_at: new Date().toISOString(),
    last_saved_by: 'admin'
  });
}

async function restoreBackup(paths = createPaths(), id) {
  const backupPath = path.join(paths.backupDir, `${id}-rule.js`);
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup not found: ${id}`);
  }
  const source = fs.readFileSync(backupPath, 'utf8');
  assertSyntax(source);
  createBackup(paths);
  fs.copyFileSync(backupPath, paths.runtimeRulePath);
  return writeMeta(paths, {
    last_import_source: 'admin',
    last_import_path: '',
    last_import_hash: hashContent(source),
    last_saved_at: new Date().toISOString(),
    last_saved_by: 'admin'
  });
}
```

- [ ] **Step 7: Export functions**

Export:

```js
module.exports = {
  EMPTY_RULE,
  createPaths,
  ensureRuntimeRule,
  prepareRuntimeRule,
  readMeta,
  writeMeta,
  validateSyntax,
  validateStructure,
  validateSource,
  saveRuntimeRule,
  listBackups,
  restoreBackup
};
```

- [ ] **Step 8: Run tests**

Run:

```bash
npm run test:runtime-rule
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add proxy/mitm/runtimeRule.js test/runtime-rule-tests.js
git commit -m "feat: add runtime rule manager"
```

## Task 3: Registry Runtime Rule Loading

**Files:**
- Modify: `proxy/mitm/registry.js`
- Modify: `test/mitm-registry-tests.js`

- [ ] **Step 1: Add a failing registry test for runtimeRulePath**

Append a test that creates a temp `runtime-rule.js`, calls `createRegistryFromFiles({ runtimeRulePath })`, and asserts the exported host is enabled.

- [ ] **Step 2: Run failing registry test**

Run:

```bash
npm run test:registry
```

Expected: FAIL because `runtimeRulePath` is ignored.

- [ ] **Step 3: Implement `runtimeRulePath` support**

In `createRegistryFromFiles(options = {})`, load:

```js
const runtimeRules = options.runtimeRulePath ? safeRequire(path.resolve(options.runtimeRulePath), 'Runtime rule.js') : null;
```

Then call `createRegistry()` so runtime rules are an external source. Recommended source id: `external:runtime`.

Implementation detail: add `runtimeRules` to `createRegistry()` sources after built-in rules. Keep CLI/Docker sources after runtime only for backward compatibility tests, but proxy integration should not pass CLI/Docker paths.

- [ ] **Step 4: Run registry tests**

Run:

```bash
npm run test:registry
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/mitm/registry.js test/mitm-registry-tests.js
git commit -m "feat: load runtime rule source in registry"
```

## Task 4: Proxy Startup and Restart Integration

**Files:**
- Modify: `proxy/proxy.js`
- Test: `test/runtime-rule-tests.js`, `test/mitm-registry-tests.js`, `test/mitm-runtime-tests.js`

- [ ] **Step 1: Import runtime rule manager**

At the top of `proxy/proxy.js`, add:

```js
const runtimeRule = require('./mitm/runtimeRule.js');
let runtimeRulePaths = runtimeRule.createPaths();
```

- [ ] **Step 2: Prepare runtime rule during `LocalProxy.init()`**

After `await loadGlobalConfigFile();`, add:

```js
await runtimeRule.prepareRuntimeRule({
  paths: runtimeRulePaths,
  cliRulePath,
  dockerRulePath: path.join(__dirname, '../config/rule.js')
});
```

- [ ] **Step 3: Rebuild registry from runtime rule only**

Modify `rebuildRuleRegistry(config)`:

```js
async function rebuildRuleRegistry(config) {
  ruleRegistry = mitmRegistry.createRegistryFromFiles({
    config,
    runtimeRulePath: runtimeRulePaths.runtimeRulePath
  });
}
```

- [ ] **Step 4: Keep admin restart free of startup imports**

Confirm `LocalProxy.restart()` calls `start()` only. Do not call `prepareRuntimeRule()` from `restart()`.

- [ ] **Step 5: Add test hook if needed**

If tests need isolated runtime paths, expose a test-only hook:

```js
setRuntimeRulePathsForTest(nextPaths) {
  runtimeRulePaths = nextPaths;
}
```

- [ ] **Step 6: Run runtime and MITM tests**

Run:

```bash
npm run test:runtime-rule
npm run test:registry
npm run test:mitm-runtime
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add proxy/proxy.js
git commit -m "feat: load admin runtime rule in proxy"
```

## Task 5: Express Custom Rule API

**Files:**
- Modify: `server/express.js`
- Test: `test/runtime-rule-tests.js`

- [ ] **Step 1: Import runtime rule manager**

Add near existing imports:

```js
const runtimeRule = require('../proxy/mitm/runtimeRule.js');
const runtimeRulePaths = runtimeRule.createPaths();
```

- [ ] **Step 2: Add `GET /api/custom-rule`**

Return source, meta, and syntax validation. This route must not call `prepareRuntimeRule()`, because reading the editor must not re-import CLI or Docker source files. It should also avoid structural validation so opening the editor does not execute top-level rule module code.

```js
app.get('/api/custom-rule', async (req, res) => {
  try {
    runtimeRule.ensureRuntimeRule(runtimeRulePaths);
    const source = fs.readFileSync(runtimeRulePaths.runtimeRulePath, 'utf8');
    res.status(200).json({
      source,
      meta: runtimeRule.readMeta(runtimeRulePaths),
      validation: runtimeRule.validateSyntax(source)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 3: Add `POST /api/custom-rule/validate`**

Parse JSON body and return `runtimeRule.validateSource(source)`.

- [ ] **Step 4: Add `POST /api/custom-rule`**

Parse JSON body and call:

```js
await runtimeRule.saveRuntimeRule(runtimeRulePaths, {
  source: body.source,
  preferRuntimeRule: body.prefer_runtime_rule
});
```

Return updated meta and validation result.

- [ ] **Step 5: Add backup list and restore routes**

Add:

```txt
GET /api/custom-rule/backups
POST /api/custom-rule/backups/:id/restore
```

- [ ] **Step 6: Validate before restart**

At the start of `/api/restart`, read `runtime-rule.js`; if `runtimeRule.validateSource(source)` fails, return HTTP 400 and do not call `LocalProxy.restart()`.

- [ ] **Step 7: Run smoke checks**

Run:

```bash
npm run test:runtime-rule
npm run test:registry
```

Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add server/express.js
git commit -m "feat: expose custom rule admin api"
```

## Task 6: React Admin Tab

**Files:**
- Modify: `src/App.js`
- Modify: `src/App.css`

- [ ] **Step 1: Add state**

In `src/App.js`, add state for:

```js
const [customRule, setCustomRule] = useState('');
const [customRuleMeta, setCustomRuleMeta] = useState(null);
const [customRuleValidation, setCustomRuleValidation] = useState(null);
const [customRuleBackups, setCustomRuleBackups] = useState([]);
const [customRuleLoading, setCustomRuleLoading] = useState(false);
```

- [ ] **Step 2: Fetch custom rule when tab opens**

Add helper functions:

```js
const fetchCustomRule = async () => { ... GET /api/custom-rule ... };
const validateCustomRule = async () => { ... POST /api/custom-rule/validate ... };
const saveCustomRule = async () => { ... POST /api/custom-rule ... };
const fetchCustomRuleBackups = async () => { ... GET /api/custom-rule/backups ... };
const restoreCustomRuleBackup = async (id) => { ... POST /api/custom-rule/backups/${id}/restore ... };
```

- [ ] **Step 3: Add the tab button after 路由表**

Add:

```jsx
<button
  className={`tab-button ${activeTab === 'customRule' ? 'active' : ''}`}
  onClick={() => setActiveTab('customRule')}
>
  自定义 rule
</button>
```

- [ ] **Step 4: Add the editor panel**

Render when `activeTab === 'customRule'`:

```jsx
<div className="config-section tab-content custom-rule-panel">
  <h2>自定义 rule</h2>
  <label className="custom-rule-prefer">
    <input
      type="checkbox"
      checked={!!customRuleMeta?.prefer_runtime_rule}
      onChange={(e) => setCustomRuleMeta({ ...customRuleMeta, prefer_runtime_rule: e.target.checked })}
    />
    优先使用当前自定义 rule
  </label>
  <textarea
    className="custom-rule-editor"
    value={customRule}
    spellCheck="false"
    onChange={(e) => setCustomRule(e.target.value)}
  />
  <div className="custom-rule-toolbar">
    <button onClick={validateCustomRule}>检查语法</button>
    <button onClick={saveCustomRule}>保存</button>
    <button onClick={fetchCustomRuleBackups}>恢复备份</button>
    <button className="restart-btn" onClick={restartProxy}>重启代理</button>
  </div>
  {/* render validation and backups */}
</div>
```

- [ ] **Step 5: Style the editor**

In `src/App.css`, add:

```css
.custom-rule-editor {
  width: 100%;
  min-height: 520px;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.55;
  tab-size: 2;
  resize: vertical;
  border: 1px solid #d9dee7;
  border-radius: 8px;
  padding: 14px;
  background: #101418;
  color: #edf2f7;
}
```

Keep surrounding UI consistent with current tab styling.

- [ ] **Step 6: Run frontend build**

Run:

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/App.js src/App.css build
git commit -m "feat: add custom rule admin tab"
```

## Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `Useage.md`
- Modify: `wiki.md`

- [ ] **Step 1: Document source import behavior**

Add language explaining:

- `-c rule.js` and `/app/config/rule.js` are startup import sources.
- The admin editor writes `config/runtime-rule.js`.
- Admin proxy restart reloads `runtime-rule.js` only.
- Full process/container restart may re-import CLI/Docker source unless "优先使用当前自定义 rule" is enabled.

- [ ] **Step 2: Document Docker persistence**

Explain:

- Mounting only `/app/config/rule.js` provides an import source.
- Mounting `/app/config/` persists admin-edited runtime rule and backups.

- [ ] **Step 3: Document security**

Warn that editing rule code is equivalent to code execution in the proxy process and port 8003 should require credentials on untrusted networks.

- [ ] **Step 4: Commit**

```bash
git add README.md Useage.md wiki.md
git commit -m "docs: describe custom runtime rule editor"
```

## Task 8: Final Verification

**Files:**
- All changed files

- [ ] **Step 1: Run focused tests**

```bash
npm run test:runtime-rule
npm run test:registry
npm run test:mitm-runtime
```

Expected: all PASS.

- [ ] **Step 2: Run proxy test suite**

```bash
npm run test:proxy
```

Expected: all PASS.

- [ ] **Step 3: Run production build**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Manual smoke test**

Run the app:

```bash
npm run start
```

Open `http://localhost:8003`, then verify:

- "自定义 rule" tab loads source.
- Syntax error blocks save and does not overwrite the previous file.
- Valid source saves.
- Backup appears after save.
- Restore replaces editor content.
- "优先使用当前自定义 rule" persists after reload.
- "重启代理" succeeds with a valid rule and fails with invalid runtime source.

- [ ] **Step 5: Commit final fixes**

```bash
git status --short
git add <changed-files>
git commit -m "test: verify custom runtime rule editor"
```
