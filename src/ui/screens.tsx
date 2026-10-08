/**
 * 두 개의 큰 화면: HomeScreen (CLI 목록), ProfilesScreen (CLI 의 프로필 관리).
 * 입력 처리는 자기 자신만 하고, 액션은 콜백으로 위임한다.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';

import type { CompareResult, FreshnessReport } from '../core/freshness.js';
import type { CliDef, Profile } from '../core/types.js';
import { msg } from '../i18n/index.js';
import { displayDetail } from '../core/freshness-detail.js';

/**
 * HomeScreen 의 한 줄 항목. 한 CLI 의 상태 요약.
 */
export interface CliRow {
  cli: CliDef;
  /** 활성 프로필 이름. 없으면 undefined. */
  active?: string;
  /** 해당 CLI 의 저장된 프로필 개수. */
  profileCount: number;
  /** 모든 source 가 라이브 위치에 존재하는가 (완전 자격증명). */
  hasLive: boolean;
}

interface HomeScreenProps {
  items: CliRow[];
  onSelect: (cliId: string) => void;
  onQuit: () => void;
}

/** 홈: CLI 목록 + 활성 프로필 / 라이브 자격증명 상태 표시. */
export function HomeScreen({ items, onSelect, onQuit }: HomeScreenProps) {
  useInput((input) => {
    if (input === 'q') onQuit();
  });

  const selectItems = items.map((it) => ({
    label: formatCliLabel(it),
    value: it.cli.id,
    key: it.cli.id
  }));

  const m = msg().screens.home;
  return (
    <Box flexDirection="column">
      <Text bold>{m.title}</Text>
      <Box marginTop={1}>
        <SelectInput items={selectItems} onSelect={(item) => onSelect(item.value)} />
      </Box>
      <Box marginTop={2}>
        <Text color="gray">{m.hints}</Text>
      </Box>
    </Box>
  );
}

function formatCliLabel(it: CliRow): string {
  const m = msg().screens.home;
  const active = it.active ? m.active(it.active) : m.noActive;
  const liveMark = it.hasLive ? m.live : m.noLive;
  const profMark = it.profileCount > 0 ? m.profileCount(it.profileCount) : m.noProfiles;
  return `${it.cli.name.padEnd(22)}  ${active.padEnd(20)}  ${liveMark.padEnd(12)}  ${profMark}`;
}

/**
 * ProfilesScreen 의 한 줄 프로필 항목.
 */
export interface ProfileItem {
  name: string;
  /** profile-store 의 meta.json 내용. 없거나 손상 시 undefined. */
  meta?: Profile;
  /** 활성 프로필 여부 (라벨/색상에 사용). */
  isActive: boolean;
}

interface ProfilesScreenProps {
  cli: CliDef;
  active?: string;
  profiles: ProfileItem[];
  onSwitch: (name: string) => void;
  onAdd: () => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
  onCapture: (name: string) => void;
  onBack: () => void;
}

/**
 * 프로필 화면: 프로필 목록 + 액션 키.
 * - ↵: 전환  c: 캡처  a: 새 프로필  r: 이름변경  d: 삭제  esc: 뒤로
 *
 * focusIndex 는 useEffect 로 profiles 길이가 변경될 때 자동 clamp 되어
 * out-of-range 가 되지 않도록 보장한다 (삭제/이름변경 후 안정성).
 */
export function ProfilesScreen({
  cli,
  active,
  profiles,
  onSwitch,
  onAdd,
  onRename,
  onDelete,
  onCapture,
  onBack
}: ProfilesScreenProps) {
  const [focusIndex, setFocusIndex] = useState(0);

  useEffect(() => {
    if (profiles.length === 0) {
      if (focusIndex !== 0) setFocusIndex(0);
    } else if (focusIndex >= profiles.length) {
      setFocusIndex(profiles.length - 1);
    }
  }, [profiles.length, focusIndex]);

  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (input === 'a') { onAdd(); return; }
    if (profiles.length === 0) return;

    const safeIndex = Math.min(focusIndex, profiles.length - 1);
    if (key.upArrow) {
      setFocusIndex((i) => (i - 1 + profiles.length) % profiles.length);
      return;
    }
    if (key.downArrow) {
      setFocusIndex((i) => (i + 1) % profiles.length);
      return;
    }

    const current = profiles[safeIndex];
    if (!current) return;
    if (key.return) { onSwitch(current.name); return; }
    if (input === 'r') { onRename(current.name); return; }
    if (input === 'd') { onDelete(current.name); return; }
    if (input === 'c') { onCapture(current.name); return; }
  });

  const m = msg().screens.profiles;
  return (
    <Box flexDirection="column">
      <Text bold>{cli.name}</Text>
      <Text color="gray">{m.activeProfile(active ?? m.none)}</Text>
      <Box marginTop={1} flexDirection="column">
        {profiles.length === 0 ? (
          <Text color="gray">{m.empty}</Text>
        ) : (
          profiles.map((p, idx) => (
            <ProfileRow
              key={p.name}
              item={p}
              focused={idx === Math.min(focusIndex, profiles.length - 1)}
            />
          ))
        )}
      </Box>
      <Box marginTop={2} flexDirection="column">
        <Text color="gray">  ────────────────────────────────────────</Text>
        <Text color="gray">{m.hintsLine1}</Text>
        <Text color="gray">{m.hintsLine2}</Text>
      </Box>
    </Box>
  );
}

function ProfileRow({ item, focused }: { item: ProfileItem; focused: boolean }) {
  const cursor = focused ? '›' : ' ';
  const color = focused ? 'cyan' : undefined;
  const m = msg().screens.profiles;
  const activeMark = item.isActive ? m.activeMark : '';
  const pendingMark = item.meta?.startsLoggedOut ? m.pendingMark : '';
  const updated = item.meta?.updatedAt ? ` · ${formatRelative(item.meta.updatedAt)}` : '';
  return (
    <Box>
      <Text color={color}>  {cursor} </Text>
      <Text color={color} bold={focused}>{item.name}</Text>
      <Text color="gray">{activeMark}{pendingMark}{updated}</Text>
    </Box>
  );
}

interface AddModeScreenProps {
  cliName: string;
  name: string;
  onFresh: () => void;
  onCopy: () => void;
  onCancel: () => void;
}

/** 새 프로필의 시작 방식 선택. 기본값은 새 계정(로그아웃 상태로 전환). */
export function AddModeScreen({ cliName, name, onFresh, onCopy, onCancel }: AddModeScreenProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });
  const m = msg().screens.addMode;
  const items = [
    { label: m.fresh, value: 'fresh', key: 'fresh' },
    { label: m.copy, value: 'copy', key: 'copy' }
  ];
  return (
    <Box flexDirection="column">
      <Text bold>{m.title(cliName, name)}</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => (item.value === 'fresh' ? onFresh() : onCopy())} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">{m.noteLine1}</Text>
        <Text color="gray">{m.noteLine2}</Text>
        <Text color="gray">{m.hints}</Text>
      </Box>
    </Box>
  );
}

function formatRelative(iso: string): string {
  const m = msg().screens.relative;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return m.justNow;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return m.justNow;
  if (mins < 60) return m.minutesAgo(mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return m.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return m.daysAgo(days);
  const months = Math.floor(days / 30);
  return m.monthsAgo(months);
}

interface FreshnessDialogProps {
  mode: 'switch' | 'create';
  fromProfile: string;
  toProfile: string;
  report: FreshnessReport;
  ambientWarningBlock?: string;
  /** 첫 표시 시 true — 한국어 onboarding 패널 함께 출력. */
  showOnboarding: boolean;
  onRecapture: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * PR-G: 라이브 자격증명이 활성 프로필 저장본과 다를 때 (OAuth refresh rotation 등)
 * 사용자에게 재캡처 / 폐기 / 취소 3-옵션을 묻는 dialog.
 *
 * 키바인딩:
 *  - r 또는 ↵: 재캡처 (라이브를 활성 프로필에 저장 후 진행)
 *  - d: 폐기 (라이브 무시 — 데이터 손실 위험)
 *  - c 또는 esc: 취소
 *
 * 렌더링 전제: app.tsx 의 `renderScreen` 이 스택 최상단 화면 1개만 렌더링하므로 본
 * dialog 와 ProfilesScreen (`c`=capture) 의 키가 겹쳐도 한 시점에 하나만 활성. 향후
 * 모달 오버레이로 전환 시 재검증 필요.
 *
 * submittedRef 가드로 사용자 더블 Enter 시 단일 액션만 발사된다 (race 방지 — Confirm
 * 위젯과 동일 패턴).
 */
export function FreshnessDialog({
  mode,
  fromProfile,
  toProfile,
  report,
  ambientWarningBlock,
  showOnboarding,
  onRecapture,
  onDiscard,
  onCancel
}: FreshnessDialogProps) {
  useFreshnessDialogKeys({ onRecapture, onDiscard, onCancel });
  const hasStale = report.sources.some((s) => s.result.kind === 'stale');
  return (
    <Box flexDirection="column">
      <FreshnessDialogHeader hasStale={hasStale} />
      <FreshnessDialogTarget mode={mode} fromProfile={fromProfile} toProfile={toProfile} />
      <FreshnessDialogSources sources={report.sources} />
      {ambientWarningBlock ? <Box marginTop={1}><Text color="yellow">{ambientWarningBlock}</Text></Box> : null}
      {showOnboarding ? <OnboardingPanel /> : null}
      <FreshnessDialogOptions
        mode={mode}
        fromProfile={fromProfile}
        toProfile={toProfile}
        hasStale={hasStale}
      />
    </Box>
  );
}

/**
 * 키바인딩 + submittedRef double-fire 가드를 캡슐화한 hook. PR-G #11 fix 의 일환으로
 * FreshnessDialog 본문에서 분리 — 본문이 렌더링 로직만 책임지도록.
 */
function useFreshnessDialogKeys(opts: {
  onRecapture: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}): void {
  const submittedRef = useRef(false);
  useInput((input, key) => {
    if (submittedRef.current) return;
    if (key.escape || input === 'c' || input === 'C') {
      submittedRef.current = true;
      opts.onCancel();
      return;
    }
    if (input === 'd' || input === 'D') {
      submittedRef.current = true;
      opts.onDiscard();
      return;
    }
    if (input === 'r' || input === 'R' || key.return) {
      submittedRef.current = true;
      opts.onRecapture();
    }
  });
}

/** 헤더: stale 여부에 따라 색상 + 제목 분기. */
function FreshnessDialogHeader({ hasStale }: { hasStale: boolean }) {
  const color = hasStale ? 'red' : 'yellow';
  const m = msg().screens.freshness;
  const title = hasStale ? m.titleStale : m.titleRotated;
  return <Text bold color={color}>{title}</Text>;
}

/** 활성/대상 프로필 표시. switch / create mode 별 부가 라벨. */
function FreshnessDialogTarget({
  mode,
  fromProfile,
  toProfile
}: { mode: 'switch' | 'create'; fromProfile: string; toProfile: string }) {
  const m = msg().screens.freshness;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{m.activeProfileLabel}<Text bold>{fromProfile}</Text></Text>
      <Text>
        {m.targetLabel}
        <Text bold>{toProfile}</Text>
        <Text color="gray">
          {mode === 'switch' ? m.modeSwitch : m.modeCreate}
        </Text>
      </Text>
    </Box>
  );
}

/** source 별 status row. */
function FreshnessDialogSources({ sources }: { sources: FreshnessReport['sources'] }) {
  return (
    <Box marginTop={1} flexDirection="column">
      {sources.map((s) => (
        <Text key={s.saveAs} color={statusColor(s.result)}>
          {`  ${s.saveAs.padEnd(28)} ${formatDialogStatus(s.result)}`}
        </Text>
      ))}
    </Box>
  );
}

/** 3-option 본문: 재캡처 / 폐기 / 취소. mode + hasStale 에 따라 설명 분기. */
function FreshnessDialogOptions({
  mode,
  fromProfile,
  toProfile,
  hasStale
}: { mode: 'switch' | 'create'; fromProfile: string; toProfile: string; hasStale: boolean }) {
  const m = msg().screens.freshness;
  const discardColor = hasStale ? 'red' : 'yellow';
  const recaptureBody = mode === 'switch'
    ? m.recaptureBodySwitch(fromProfile)
    : m.recaptureBodyCreate(fromProfile);
  const discardBody = mode === 'switch'
    ? m.discardBodySwitch(toProfile)
    : m.discardBodyCreate(fromProfile, toProfile);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="green">{m.recaptureOption}</Text>
      <Text color="gray">{recaptureBody}</Text>
      <Text color={discardColor}>{m.discardOption}</Text>
      <Text color="gray">{discardBody}</Text>
      <Text color="gray">{m.cancelOption}</Text>
    </Box>
  );
}

/**
 * 첫 표시 시 한국어 onboarding 패널 — 왜 dialog 가 나오는지 + 권장 선택을 설명.
 * 두 번째 표시부터는 본 패널 생략 (markFirstFreshnessPromptShown 플래그 기반).
 */
function OnboardingPanel() {
  const m = msg().screens.onboarding;
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{m.title}</Text>
      <Text color="gray">{m.line1}</Text>
      <Text color="gray">{m.line2}</Text>
      <Text color="gray">{m.line3}</Text>
      <Text color="gray">
        {m.line4Before}<Text bold color="green">{m.line4Emphasis}</Text>{m.line4After}
      </Text>
    </Box>
  );
}

/** Status row 의 색상 — kind 기준 (fresh=green / stale=red / 그 외 yellow). */
function statusColor(result: CompareResult): string | undefined {
  if (result.kind === 'fresh') return 'green';
  if (result.kind === 'stale') return 'red';
  if (result.kind === 'inflight') return 'yellow';
  if (result.kind === 'unsupported') return 'red';
  // rotated
  return 'yellow';
}

/**
 * Dialog row 한 줄 포맷 — kind/subtype/confidence + detail.
 *
 * PR-G quad-review #14 (Codex-3): SourceAdapter contract 가 detail 의 raw
 * 자격증명 노출을 금지하지만 plugin 작성자가 실수할 수 있으므로 방어적으로
 * 256자 truncate + token-like 정규식 마스킹. 진짜 방어는 adapter 책임 (freshness.ts
 * SourceAdapter JSDoc).
 */
function formatDialogStatus(result: CompareResult): string {
  const subtype = result.kind === 'rotated' && result.subtype ? `(${result.subtype})` : '';
  const conf = result.confidence === 'low' ? ' [low conf]' : '';
  const shown = displayDetail(result);
  const detail = shown ? ` — ${sanitizeDialogDetail(shown)}` : '';
  return `${result.kind}${subtype}${conf}${detail}`;
}

const MAX_DETAIL_LEN = 256;

/**
 * Token-like 시퀀스 (영숫자/`-`/`_`/`.` 만 32자 이상) 를 `[redacted]` 로 치환.
 * 일반 한국어 / 영어 문장은 영향 없음 (공백 포함 시 분리됨).
 * 그 후 전체 길이 MAX_DETAIL_LEN 으로 자른다.
 */
function sanitizeDialogDetail(detail: string): string {
  const redacted = detail.replace(/[A-Za-z0-9_\-.]{32,}/g, '[redacted]');
  if (redacted.length <= MAX_DETAIL_LEN) return redacted;
  return `${redacted.slice(0, MAX_DETAIL_LEN)}...`;
}
