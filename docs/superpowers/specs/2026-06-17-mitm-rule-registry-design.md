# MITM Rule Registry Design

## Background

`block-proxy` currently loads built-in MITM rules from `proxy/mitm/rule.js` and merges optional external `rule.js` files into the same global `Rule` object. External rules can be loaded from:

- A CLI-provided config file path stored through `config_file`.
- A Docker-mounted file at `config/rule.js`.

This keeps old custom rules working, but it also couples built-in behavior, external behavior, MITM host selection, response rewrite buffering, and YouTube-specific UA filtering. The admin UI cannot show which rule groups are loaded or let users enable and disable them independently.

## Goals

- Keep old external `rule.js` format fully compatible.
- Add optional support for a richer external rule format with metadata.
- Treat built-in and external rules as rule groups keyed by the top-level export key.
- Add a backend "Rule 逻辑区块" where each rule group can be enabled or disabled.
- Ensure disabled rules do not affect request rewriting, response rewriting, forced MITM host selection, response buffering, or YouTube UA filtering.
- Preserve current behavior for existing installs unless users explicitly disable a rule group.

## Non-Goals

- Do not build a plugin system.
- Do not add per-rule-item toggles inside a rule group.
- Do not hot-reload rule files in the first version.
- Do not require existing external rule files to change.

## Rule Group Model

The control unit is a rule group, not an individual rule item. A rule group is created from each top-level key exported by a `rule.js` file.

Old external format remains valid:

```js
module.exports = {
  MyRule: [
    {
      type: "beforeSendRequest",
      host: "example.com",
      regexp: "^https://example.com/",
      callback: async function(url, request, response) {
        return null;
      }
    }
  ]
};
```

New optional format:

```js
module.exports = {
  MyRule: {
    name: "Custom Example Rule",
    description: "Rewrites selected example.com requests",
    rules: [
      {
        type: "beforeSendRequest",
        host: "example.com",
        regexp: "^https://example.com/",
        callback: async function(url, request, response) {
          return null;
        }
      }
    ]
  }
};
```

Both formats normalize into:

```js
{
  id: "external:cli:MyRule",
  source: "external:cli",
  key: "MyRule",
  name: "MyRule",
  description: "外部自定义规则",
  rules: []
}
```

## Registry

Add `proxy/mitm/registry.js`.

Responsibilities:

- Load built-in rule groups.
- Load the CLI-provided external rule file.
- Load the Docker-mounted external rule file.
- Normalize old and new rule formats.
- Assign stable IDs.
- Compile each rule item's `regexp`.
- Return enabled rules for runtime proxy logic.
- Return rule group metadata for the admin API.

Suggested IDs:

- `builtin:Youtube`
- `builtin:YDCD`
- `external:cli:MyRule`
- `external:docker:MyRule`

Using source-qualified IDs avoids collisions when built-in and external rules share the same key, or when CLI and Docker external rules both export the same key.

To preserve existing behavior, rule group resolution must still follow the legacy override order:

1. Built-in rules are loaded first.
2. CLI external rules are loaded second.
3. Docker external rules are loaded last.

If a later source exports the same top-level key as an earlier source, the later source shadows the earlier source for runtime execution. For example, a CLI rule named `Youtube` continues to replace the built-in `Youtube` group, and a Docker rule named `Youtube` replaces both. The registry may keep shadowed groups in memory for diagnostics, but `/api/rules` and runtime rule lists must expose only the effective group for each key. The effective group's ID still includes its source, such as `external:cli:Youtube`.

CLI-provided rule files remain one-shot inputs, matching the current behavior where `config_file` is consumed and cleared after startup. If the process is restarted without passing the CLI rule file again, those `external:cli:*` groups disappear from the registry and from `/api/rules`. Docker-mounted rules remain available as long as `config/rule.js` exists.

External `require()` failures must not crash the proxy. The registry should log the failed path and error, skip that source, and continue loading other sources.

Malformed groups or rule items should be skipped with logs:

- A group with neither an array value nor an object with an array `rules` field is invalid.
- A rule item missing `type`, `host`, `regexp`, or `callback` is invalid.
- A rule item whose `callback` is not a function is invalid.
- A rule item with an invalid `regexp` is invalid.
- `ruleCount` should count only valid compiled rule items.

## Built-In Rules

Refactor `proxy/mitm/rule.js` into a built-in rule registry export while preserving the existing rule item shape.

Suggested shape:

```js
module.exports = {
  Youtube: {
    name: "YouTube 广告拦截",
    description: "拦截 YouTube App 视频广告",
    rules: []
  },
  YDCD: {
    name: "有道词典 VIP",
    description: "解锁有道词典 VIP 会员功能",
    rules: []
  }
};
```

The registry should also accept the old array shape for built-ins during migration, so this refactor can be low risk.

## Config

Add `rule_modules` to `config.json`:

```json
{
  "enable_mitm": "1",
  "rule_modules": {
    "builtin:Youtube": true,
    "builtin:YDCD": true,
    "external:cli:MyRule": true,
    "external:docker:MyRule": true
  }
}
```

Compatibility behavior:

- Missing `rule_modules` means every loaded rule group is enabled.
- Missing entry for a specific rule group means that group is enabled.
- Only explicit `false` disables a group.
- `enable_mitm` remains the global MITM switch.
- `rule_modules` only controls rule groups when MITM processing is otherwise active.

## Runtime Integration

All runtime rule consumers must use the registry's enabled rule list:

- `preCompileRuleRegexp()`
- `MITMHandler()`
- `getResponseRules()`
- `shouldMitm()`

The YouTube UA filter must be tied to the effective built-in `builtin:Youtube` group. If `builtin:Youtube` is disabled or shadowed by an external `Youtube` group, `uaFilter.match()` must not special-case YouTube browser traffic. External `Youtube` groups can provide their own behavior through normal rule items, but they do not inherit the built-in UA filter side effect.

This prevents partial disable behavior where a disabled rule still forces HTTPS MITM, changes response buffering, or bypasses browser traffic handling.

Callback invocation must preserve legacy `this` behavior. Existing callbacks can depend on `this` being the rule item, as the current `item.callback(...)` call does. If registry normalization clones or wraps rule items, runtime execution must call callbacks with the normalized rule as context:

```js
rule.callback.call(rule, url, request, response)
```

The normalized rule must retain fields such as `regexp` and `compiledRegexp`.

## Admin API

Add:

```txt
GET /api/rules
```

Response:

```json
[
  {
    "id": "builtin:Youtube",
    "source": "builtin",
    "key": "Youtube",
    "name": "YouTube 广告拦截",
    "description": "拦截 YouTube App 视频广告",
    "enabled": true,
    "ruleCount": 2
  },
  {
    "id": "external:docker:MyRule",
    "source": "external:docker",
    "key": "MyRule",
    "name": "MyRule",
    "description": "外部自定义规则",
    "enabled": true,
    "ruleCount": 1
  }
]
```

Saving enabled states can continue through the existing `POST /api/config` endpoint by updating `config.rule_modules`.

## Admin UI

Add a "Rule 逻辑区块" below "HTTPS MITM 解密".

Each row shows:

- Checkbox for enabled state.
- Display name.
- Source label: `builtin`, `external:cli`, or `external:docker`.
- Rule count.
- Description.

When `enable_mitm !== "1"`, keep the block visible but disabled, with copy indicating that MITM is off and rule groups will not take effect until MITM is enabled.

## Restart and Reload Behavior

First version should keep the current restart-oriented behavior:

- Rule files are loaded during proxy initialization.
- Config changes are saved through the admin UI.
- Users restart the proxy through the existing admin flow for rule file or rule enablement changes to take effect.

Current lifecycle detail: `LocalProxy.init()` loads rules today, but `LocalProxy.restart()` calls `start()` directly. The implementation must move registry rebuild/config binding into a path that runs for both initial startup and admin restart. Before each `AnyProxy.ProxyServer` instance is created, the proxy must rebuild or refresh the registry from the current config and loaded rule sources, then regenerate `responseRules` from the enabled effective groups.

Hot reload without restart is intentionally deferred because it requires reliable `require()` cache invalidation, recompilation, and global runtime state replacement.

## Testing

Add focused tests or verification around:

- Old external format normalizes correctly.
- New external metadata format normalizes correctly.
- Missing `rule_modules` enables all groups.
- Explicit `false` disables one group.
- Disabled groups are absent from MITM handler rules, response rules, and MITM host selection.
- YouTube UA filter only runs when `builtin:Youtube` is enabled.

Manual verification:

- Start with no external rule file and confirm built-ins appear enabled.
- Add a Docker or CLI external `rule.js` in old format and confirm it appears in the UI.
- Disable a rule group, save config, restart proxy, and confirm the rule no longer affects traffic.
