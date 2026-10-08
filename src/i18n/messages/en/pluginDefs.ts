/** 영어 메시지 — `pluginDefs` 영역. 키 구조가 기준 스키마이며 ko/pluginDefs.ts 가 같은 키를 가져야 한다. */
export const pluginDefs = {
  // cli-defs-plugin.ts — parseSource / parseWindowsCredentialSource
  sourceNotObject: (idx: number) => `sources[${idx}] must be an object.`,
  sourceTypeInvalid: (idx: number) =>
    `sources[${idx}].type must be 'file', 'keychain', 'os-keyring', 'env-secret', or 'win-credential'. directory is builtin-only.`,
  saveAsNotString: (idx: number) => `sources[${idx}].saveAs must be a string.`,
  pathEmpty: (idx: number) => `sources[${idx}].path must be a non-empty string.`,
  pathUnsafeChar: (idx: number) => `sources[${idx}].path must not contain control or format characters.`,
  pathNotAbsolute: (idx: number) =>
    `sources[${idx}].path must start with '~/' or be an absolute path. A relative path points to different files depending on the working directory.`,
  pathNotNormalized: (idx: number) =>
    `sources[${idx}].path must be a normalized path (no '.', '..', or duplicate slashes). Example: '~/.config/app/auth.json'`,
  pathInGooseZone: (idx: number) =>
    `sources[${idx}].path is inside the Goose credentials area managed by mat builtin (~/.config/goose) but is not an approved fixed path. Use builtin goose support or specify a path outside that area.`,
  serviceEmpty: (idx: number) => `sources[${idx}].service must be a non-empty string.`,
  serviceWhitespace: (idx: number) => `sources[${idx}].service must not have leading or trailing whitespace.`,
  serviceTooLong: (idx: number, max: number) => `sources[${idx}].service must be at most ${max} characters.`,
  serviceUnsafeChar: (idx: number) => `sources[${idx}].service must not contain control or format characters.`,
  accountEmpty: (idx: number) => `sources[${idx}].account must be a non-empty string.`,
  accountUnsafeChar: (idx: number) => `sources[${idx}].account must not contain control or format characters.`,
  backendInvalid: (idx: number) => `sources[${idx}].backend must be 'auto' or 'secret-service'.`,
  targetNameEmpty: (idx: number) => `sources[${idx}].targetName must be a non-empty string.`,
  credentialTypeInvalid: (idx: number) => `sources[${idx}].credentialType must be 'generic'.`,
  persistInvalid: (idx: number) => `sources[${idx}].persist must be 'session', 'local-machine', or 'enterprise'.`,

  // cli-defs-plugin.ts — validateCliDefRaw
  topLevelNotObject: 'The top level must be a JSON object.',
  idNotString: 'id must be a string.',
  nameEmpty: 'name must be a non-empty string.',
  nameWhitespace: 'name must not have leading or trailing whitespace.',
  nameTooLong: (max: number) => `name must be at most ${max} characters.`,
  nameUnsafeChar: 'name must not contain control or format characters.',
  sourcesEmpty: 'sources must be a non-empty array.',

  // cli-defs-plugin.ts — `mat plugin validate` diagnostics (message 만 번역, code 는 고정)
  builtinIdCollision: (id: string) => `plugin id '${id}' conflicts with a builtin CLI and is ignored at load time.`,
  ignoredTrustBoundaryField: (field: string) =>
    `plugin field '${field}' is ignored. plugins cannot define session isolation, env policy, or ambient override controls.`,
  genericServiceWithoutAccount: (idx: number, service: string) =>
    `sources[${idx}].service '${service}' looks like a generic/multi-account credential service. Specify account to prevent swapping the wrong account.`,
  broadFilePath: (path: string) =>
    `sources[].path '${path}' is too broad to be a credential file. Specify a concrete file path.`,
  suspiciousFilePath: (path: string) =>
    `sources[].path '${path}' looks like a directory path with no file name or extension. Check that it points to a credential file.`,
  fileReadError: (message: string) => `Failed to read plugin file — ${message}`,
  jsonParseError: (message: string) => `Failed to parse JSON — ${message}`,
  directoryReadError: (message: string) => `Failed to read cli-defs directory — ${message}`,
  duplicatePluginId: (id: string) =>
    `plugin id '${id}' conflicts with another plugin; later entries are ignored at load time.`,
  builtinLiveResourceCollision: (sourceIndex: number, owner: string, kind: string, declared: string) =>
    `sources[${sourceIndex}] claims live credentials owned by builtin '${owner}' (${kind}: ${declared}) — this entire plugin is ignored at load time. Saved profiles are not deleted.`,

  // cli-defs-plugin.ts — loadUserCliDefs warnings
  loadDirectoryReadError: (message: string) => `Failed to read cli-defs directory: ${message}`,
  loadJsonParseError: (file: string, message: string) => `${file}: failed to parse JSON — ${message}`,
  loadDuplicateId: (file: string, id: string) => `${file}: id '${id}' conflicts with another plugin — skipped`,

  // cli-defs.ts — getAllCliDefs warnings
  loadBuiltinIdCollision: (id: string) => `${id}: id conflicts with a builtin — plugin ignored`,
  loadBuiltinLiveResourceCollision: (
    where: string,
    id: string,
    sourceIndex: number,
    owner: string,
    kind: string,
    declared: string
  ) =>
    `${where}: sources[${sourceIndex}] of plugin '${id}' ` +
    `claims live credentials owned by builtin '${owner}' (${kind}: ${declared}), ` +
    `so the entire plugin was not loaded. ` +
    `Saved profiles remain in ~/.multi-account-tool/profiles/${id}/ and were not deleted.`,

  // builtin-live-resources.ts — 해석 실패 거부의 소유자 자리표시자 (실제 cliId 아님)
  unresolvableOwner: '(unresolvable)'
};
