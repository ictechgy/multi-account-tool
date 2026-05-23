/**
 * 두 개의 큰 화면: HomeScreen (CLI 목록), ProfilesScreen (CLI 의 프로필 관리).
 * 입력 처리는 자기 자신만 하고, 액션은 콜백으로 위임한다.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';

import type { CliDef, Profile } from '../core/types.js';

export interface CliRow {
  cli: CliDef;
  active?: string;
  profileCount: number;
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

  return (
    <Box flexDirection="column">
      <Text bold>  CLI 를 선택하세요:</Text>
      <Box marginTop={1}>
        <SelectInput items={selectItems} onSelect={(item) => onSelect(item.value)} />
      </Box>
      <Box marginTop={2}>
        <Text color="gray">  ↑↓ 이동  ↵ 선택  q 종료</Text>
      </Box>
    </Box>
  );
}

function formatCliLabel(it: CliRow): string {
  const active = it.active ? `활성: ${it.active}` : '활성: -';
  const liveMark = it.hasLive ? '✓ live' : '⚠ live 없음';
  const profMark = it.profileCount > 0 ? `${it.profileCount}개 프로필` : '프로필 없음';
  return `${it.cli.name.padEnd(22)}  ${active.padEnd(20)}  ${liveMark.padEnd(12)}  ${profMark}`;
}

export interface ProfileItem {
  name: string;
  meta?: Profile;
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

  return (
    <Box flexDirection="column">
      <Text bold>{cli.name}</Text>
      <Text color="gray">  활성 프로필: {active ?? '(없음)'}</Text>
      <Box marginTop={1} flexDirection="column">
        {profiles.length === 0 ? (
          <Text color="gray">  프로필이 없습니다. 'a' 키로 새 프로필을 추가하세요.</Text>
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
        <Text color="gray">  ↵ 이 프로필로 전환    c 캡처(라이브→프로필)    a 새 프로필</Text>
        <Text color="gray">  r 이름 변경    d 삭제    esc 뒤로</Text>
      </Box>
    </Box>
  );
}

function ProfileRow({ item, focused }: { item: ProfileItem; focused: boolean }) {
  const cursor = focused ? '›' : ' ';
  const color = focused ? 'cyan' : undefined;
  const activeMark = item.isActive ? ' (활성)' : '';
  const updated = item.meta?.updatedAt ? ` · ${formatRelative(item.meta.updatedAt)}` : '';
  return (
    <Box>
      <Text color={color}>  {cursor} </Text>
      <Text color={color} bold={focused}>{item.name}</Text>
      <Text color="gray">{activeMark}{updated}</Text>
    </Box>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return '방금';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  return `${months}달 전`;
}
