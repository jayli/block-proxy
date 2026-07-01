# Admin Runtime Rule Editor Design

## Background

`block-proxy` currently supports external MITM rules from two startup-time sources:

- CLI: `block-proxy -c /path/to/rule.js`
- Docker: `/app/config/rule.js`

The current proxy registry loads built-in rules, then CLI rules, then Docker rules. Later sources shadow earlier sources by top-level rule group key. The `-c` path is passed through `config.json.config_file` and consumed once during `LocalProxy.init()`, while the admin "restart" action only restarts the in-process AnyProxy server.

The admin UI needs a new "自定义 rule" tab after "路由表". Users should be able to view, edit, validate, save, back up, restore, and restart with a custom `rule.js` without mutating the original CLI-provided or Docker-mounted source file.

## Goals

- Add one admin-managed runtime rule file as the only external rule file loaded by the proxy after startup import.
- Keep CLI and Docker rule files as import sources, not live runtime files.
- Let users edit the runtime rule from the 8003 admin UI.
- Support syntax checking, structural rule validation, save, backup, restore, and restart.
- Add a persistent "优先使用当前自定义 rule" setting.
- Preserve existing startup behavior unless the new setting explicitly asks to keep the admin-managed runtime rule.
- Keep old and new external rule module formats compatible with the existing registry.

## Non-Goals

- Do not implement hot reload on every keystroke.
- Do not build a sandbox for executing untrusted rule code.
- Do not support per-rule-item editing forms.
- Do not replace the existing rule group enable/disable system.
- Do not make the admin UI write directly to the original `-c` file or Docker-mounted `/app/config/rule.js`.

## Runtime Rule Files

Use stable files under the project runtime config directory instead of OS temporary storage:

```txt
config/
  rule.js                    # Docker-mounted source, optional, read-only from admin semantics
  runtime-custom-rule.js       # Admin-managed runtime rule, loaded by registry
  runtime-custom-rule-meta.json # Runtime rule setting and source metadata
  rule-backups/
    20260630-153012-rule.js
    20260630-153012-meta.json
```

`config/runtime-custom-rule.js` is the only non-built-in external rule file loaded by the proxy registry. The CLI path and Docker path are only copied into `runtime-custom-rule.js` during full process startup when import policy allows it.

If `config/` does not exist, the backend creates it. If `runtime-custom-rule.js` does not exist and no source is imported, the backend creates an empty valid module:

```js
module.exports = {};
```

## Metadata

`config/runtime-custom-rule-meta.json` stores:

```json
{
  "prefer_runtime_rule": false,
  "last_import_source": "docker",
  "last_import_path": "/app/config/rule.js",
  "last_import_hash": "sha256:...",
  "last_saved_at": "2026-06-30T07:30:12.000Z",
  "last_saved_by": "admin"
}
```

Field semantics:

- `prefer_runtime_rule`: when `true`, full process startup keeps the existing `runtime-custom-rule.js` and ignores CLI/Docker imports.
- `last_import_source`: `cli`, `docker`, `runtime`, `empty`, or `admin`.
- `last_import_path`: original source path for CLI/Docker imports, or empty string.
- `last_import_hash`: SHA-256 hash of the imported or saved rule content.
- `last_saved_at`: ISO timestamp of the latest admin save or startup import.
- `last_saved_by`: `startup` or `admin`.

## Startup Import Policy

On every full process start:

1. Capture the CLI rule path from the existing one-shot `config_file` mechanism.
2. Detect the Docker source at `config/rule.js`.
3. Read `runtime-custom-rule-meta.json`, defaulting `prefer_runtime_rule` to `false`.
4. If `prefer_runtime_rule === true`:
   - Do not copy CLI or Docker source files.
   - Ensure `runtime-custom-rule.js` exists.
5. If `prefer_runtime_rule !== true`:
   - If Docker source exists, copy `config/rule.js` to `config/runtime-custom-rule.js`.
   - Else if CLI source exists, copy the CLI file to `config/runtime-custom-rule.js`.
   - Else if `runtime-custom-rule.js` does not exist, create an empty valid module.
   - Else keep the existing `runtime-custom-rule.js`.
6. Update metadata with source, path, hash, and timestamp.
7. Rebuild the registry from built-in rules plus `runtime-custom-rule.js`.

Docker keeps priority over CLI to match the current registry behavior where Docker rules shadow CLI rules.

## Admin Restart Policy

The admin "重启代理" action must not re-import CLI or Docker source files. It only restarts the in-process proxy and reloads the current `runtime-custom-rule.js`.

This is the central isolation rule:

- Full process restart may import CLI/Docker into the runtime copy, depending on `prefer_runtime_rule`.
- Admin proxy restart never re-imports CLI/Docker.
- The proxy registry never loads the original CLI/Docker path directly.

## Validation

Validation has two levels:

1. JavaScript syntax validation.
   - Parse the submitted source before saving or restarting.
   - The first implementation can use Node's built-in parser behavior through `new Function(source)` or `vm.Script`.
   - Do not execute user callbacks as part of syntax validation.
2. Rule module validation.
   - Load the saved runtime file through the existing registry's safe require path.
   - Normalize old array groups and new `{ rules: [] }` groups.
   - Return warnings/errors for invalid groups, missing `type/host/regexp/callback`, invalid callbacks, and invalid regular expressions.

Save behavior:

- `POST /api/custom-rule` validates syntax before writing.
- If syntax fails, do not overwrite `runtime-custom-rule.js`.
- If structure has invalid groups/items but the file can load, allow saving only if the registry can safely skip invalid entries. Return warnings to the UI.
- `POST /api/restart` should fail before restarting if `runtime-custom-rule.js` cannot be loaded safely.

## Backups

Before every successful admin save, create a timestamped backup of the previous `runtime-custom-rule.js` and current metadata. Backups live under `config/rule-backups/`.

Backup listing should include:

```json
{
  "id": "20260630-153012",
  "created_at": "2026-06-30T07:30:12.000Z",
  "source": "admin",
  "hash": "sha256:...",
  "size": 1204
}
```

Restore behavior:

- Restoring a backup copies the backup file to `runtime-custom-rule.js`.
- Restoring also updates metadata to `last_import_source: "admin"` and `last_saved_by: "admin"`.
- Restore validates syntax before overwriting.
- Restore does not automatically restart the proxy; the UI should let users save/restore first, then restart explicitly.

Retention can be simple in the first version: keep the latest 20 backups and delete older entries after a successful backup.

## Admin API

Add APIs under the existing authenticated `/api` middleware:

```txt
GET  /api/custom-rule
POST /api/custom-rule
POST /api/custom-rule/validate
GET  /api/custom-rule/backups
POST /api/custom-rule/backups/:id/restore
```

`GET /api/custom-rule` returns:

```json
{
  "source": "module.exports = {};",
  "meta": {
    "prefer_runtime_rule": false,
    "last_import_source": "docker",
    "last_import_path": "/app/config/rule.js"
  },
  "validation": {
    "ok": true,
    "warnings": []
  }
}
```

`POST /api/custom-rule` accepts:

```json
{
  "source": "module.exports = {};",
  "prefer_runtime_rule": true
}
```

It writes atomically: validate, back up previous file, write a temp file, rename into place, update metadata.

`POST /api/custom-rule/validate` accepts source and returns validation result without saving.

## Frontend

Add a new tab after "路由表":

```txt
基本设置 | 拦截规则 | 路由表 | 自定义 rule
```

The "自定义 rule" panel contains:

- A code editor area for `rule.js` source.
- A checkbox: "优先使用当前自定义 rule".
- Buttons:
  - "检查语法"
  - "保存"
  - "备份"
  - "恢复备份"
  - "重启代理"
- A compact status area showing source metadata, validation result, and latest save time.

First version editor:

- Use an enhanced `<textarea>` styled as a code editor.
- Use monospace font, line-height, tab-size, and fixed height.
- Avoid introducing Monaco/CodeMirror until the backend behavior is stable.

## Security

Editing `rule.js` is equivalent to granting code execution in the proxy process. The feature must remain behind the existing admin authentication middleware. Documentation should warn users not to expose port 8003 to untrusted networks without login credentials.

This design does not sandbox rule execution. That is consistent with the existing `-c rule.js` behavior.

## Testing

Add focused Node tests for the runtime rule manager:

- Creates `config/` and empty `runtime-custom-rule.js` when no source exists.
- Imports Docker source over CLI source when both exist and `prefer_runtime_rule` is false.
- Keeps existing runtime rule when `prefer_runtime_rule` is true.
- Does not mutate original CLI or Docker source files.
- Creates backups before saving.
- Restores backups.
- Rejects syntax-invalid source without overwriting the current runtime rule.

Extend registry tests:

- `createRegistryFromFiles()` loads `runtimeCustomRulePath`.
- CLI/Docker direct paths are no longer required by proxy integration once runtime import is complete.

Add API tests where practical using direct helper calls first. If Express integration tests become too heavy for the current test setup, keep the route handlers thin and cover file/validation behavior in the runtime rule manager.

## Documentation

Update `README.md`, `Useage.md`, and `wiki.md`:

- Explain that CLI/Docker rule files are startup import sources.
- Explain that 8003 edits `config/runtime-custom-rule.js`.
- Explain the "优先使用当前自定义 rule" checkbox.
- Explain persistence expectations for Docker volume mounts.
