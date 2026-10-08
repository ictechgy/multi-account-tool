import type { Messages } from '../en.js';

/** 한국어 메시지 — `pluginDefs` 영역. */
export const pluginDefs: Messages['pluginDefs'] = {
  sourceNotObject: (idx: number) => `sources[${idx}] 는 객체여야 합니다.`,
  sourceTypeInvalid: (idx: number) =>
    `sources[${idx}].type 는 'file', 'keychain', 'os-keyring', 'env-secret' 또는 'win-credential' 이어야 합니다. directory 는 builtin 전용입니다.`,
  saveAsNotString: (idx: number) => `sources[${idx}].saveAs 는 문자열이어야 합니다.`,
  pathEmpty: (idx: number) => `sources[${idx}].path 는 비어있지 않은 문자열이어야 합니다.`,
  pathUnsafeChar: (idx: number) => `sources[${idx}].path 에 제어/서식 문자가 포함될 수 없습니다.`,
  pathNotAbsolute: (idx: number) =>
    `sources[${idx}].path 는 '~/' 로 시작하거나 절대경로여야 합니다. 상대경로는 실행 디렉토리에 따라 다른 파일을 가리킵니다.`,
  pathNotNormalized: (idx: number) =>
    `sources[${idx}].path 는 정규화된 경로여야 합니다 ('.', '..', 중복 슬래시 없이). 예: '~/.config/app/auth.json'`,
  pathInGooseZone: (idx: number) =>
    `sources[${idx}].path 가 mat builtin 이 관리하는 Goose 자격증명 구역(~/.config/goose) 안에 있지만 인정된 고정 경로가 아닙니다. builtin goose 지원을 쓰거나 구역 밖 경로를 지정하세요.`,
  serviceEmpty: (idx: number) => `sources[${idx}].service 는 비어있지 않은 문자열이어야 합니다.`,
  serviceWhitespace: (idx: number) => `sources[${idx}].service 는 앞뒤 공백 없이 입력해야 합니다.`,
  serviceTooLong: (idx: number, max: number) => `sources[${idx}].service 는 ${max}자 이하여야 합니다.`,
  serviceUnsafeChar: (idx: number) => `sources[${idx}].service 에 제어/서식 문자가 포함될 수 없습니다.`,
  accountEmpty: (idx: number) => `sources[${idx}].account 는 비어있지 않은 문자열이어야 합니다.`,
  accountUnsafeChar: (idx: number) => `sources[${idx}].account 에 제어/서식 문자가 포함될 수 없습니다.`,
  backendInvalid: (idx: number) => `sources[${idx}].backend 는 'auto' 또는 'secret-service' 여야 합니다.`,
  targetNameEmpty: (idx: number) => `sources[${idx}].targetName 는 비어있지 않은 문자열이어야 합니다.`,
  credentialTypeInvalid: (idx: number) => `sources[${idx}].credentialType 은 'generic' 이어야 합니다.`,
  persistInvalid: (idx: number) => `sources[${idx}].persist 는 'session', 'local-machine' 또는 'enterprise' 이어야 합니다.`,

  topLevelNotObject: '최상위는 JSON 객체여야 합니다.',
  idNotString: 'id 는 문자열이어야 합니다.',
  nameEmpty: 'name 은 비어있지 않은 문자열이어야 합니다.',
  nameWhitespace: 'name 은 앞뒤 공백 없이 입력해야 합니다.',
  nameTooLong: (max: number) => `name 은 ${max}자 이하여야 합니다.`,
  nameUnsafeChar: 'name 에 제어/서식 문자가 포함될 수 없습니다.',
  sourcesEmpty: 'sources 는 비어있지 않은 배열이어야 합니다.',

  builtinIdCollision: (id: string) => `plugin id '${id}' 는 builtin CLI 와 충돌하여 로드 시 무시됩니다.`,
  ignoredTrustBoundaryField: (field: string) =>
    `plugin 필드 '${field}' 는 무시됩니다. plugins cannot define session isolation, env policy, or ambient override controls.`,
  genericServiceWithoutAccount: (idx: number, service: string) =>
    `sources[${idx}].service '${service}' 는 generic/multi-account credential service 처럼 보입니다. wrong-account swap 방지를 위해 account 를 명시하세요.`,
  broadFilePath: (path: string) =>
    `sources[].path '${path}' 는 credential file 로 보기에는 너무 넓은 경로입니다. 구체적인 파일 경로를 지정하세요.`,
  suspiciousFilePath: (path: string) =>
    `sources[].path '${path}' 는 파일명/확장자가 없는 디렉토리형 경로처럼 보입니다. credential 파일을 가리키는지 확인하세요.`,
  fileReadError: (message: string) => `plugin 파일 읽기 실패 — ${message}`,
  jsonParseError: (message: string) => `JSON 파싱 실패 — ${message}`,
  directoryReadError: (message: string) => `cli-defs 디렉토리 읽기 실패 — ${message}`,
  duplicatePluginId: (id: string) =>
    `plugin id '${id}' 가 다른 plugin 과 충돌하여 후속 항목은 로드 시 무시됩니다.`,
  builtinLiveResourceCollision: (sourceIndex: number, owner: string, kind: string, declared: string) =>
    `sources[${sourceIndex}] 가 builtin '${owner}' 소유의 라이브 자격증명(${kind}: ${declared})을 주장합니다 — 로드 시 이 plugin 전체가 무시됩니다. 저장된 프로필은 삭제되지 않습니다.`,

  loadDirectoryReadError: (message: string) => `cli-defs 디렉토리 읽기 실패: ${message}`,
  loadJsonParseError: (file: string, message: string) => `${file}: JSON 파싱 실패 — ${message}`,
  loadDuplicateId: (file: string, id: string) => `${file}: id '${id}' 가 다른 plugin 과 충돌 — skip`,

  loadBuiltinIdCollision: (id: string) => `${id}: builtin 과 id 충돌 — plugin 무시됨`,
  loadBuiltinLiveResourceCollision: (
    where: string,
    id: string,
    sourceIndex: number,
    owner: string,
    kind: string,
    declared: string
  ) =>
    `${where}: plugin '${id}' 의 sources[${sourceIndex}] 가 ` +
    `builtin '${owner}' 소유의 라이브 자격증명(${kind}: ${declared})을 ` +
    `주장하여 plugin 전체를 로드하지 않았습니다. ` +
    `저장된 프로필은 ~/.multi-account-tool/profiles/${id}/ 에 그대로 있으며 삭제되지 않았습니다.`,

  unresolvableOwner: '(해석 불가)'
};
