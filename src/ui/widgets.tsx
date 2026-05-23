/**
 * 재사용 가능한 작은 UI 위젯들: Header, TextPrompt, Confirm, Busy, Message.
 * 모두 자기 자신의 키 입력만 처리하고, 외부에는 콜백만 노출한다.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';

interface HeaderProps {
  title: string;
  subtitle?: string;
}

/** 화면 상단 헤더 (둥근 박스 + 제목/부제). */
export function Header({ title, subtitle }: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2}>
        <Text bold color="cyan">{title}</Text>
      </Box>
      {subtitle ? (
        <Box marginTop={1}>
          <Text color="gray">  {subtitle}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

interface TextPromptProps {
  label: string;
  placeholder?: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** null 반환 = 통과, 문자열 반환 = 에러 메시지 표시 */
  validate?: (value: string) => string | null;
}

/** 한 줄 텍스트 입력 + 검증 + 도움말. Enter 제출, Esc 취소. */
export function TextPrompt({
  label,
  placeholder,
  initial = '',
  onSubmit,
  onCancel,
  validate
}: TextPromptProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  function handleSubmit(v: string): void {
    const trimmed = v.trim();
    const err = validate ? validate(trimmed) : null;
    if (err) {
      setError(err);
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Box>
        <Text color="cyan">› </Text>
        <TextInput
          value={value}
          onChange={(v) => { setValue(v); setError(null); }}
          onSubmit={handleSubmit}
          placeholder={placeholder}
        />
      </Box>
      {error ? <Text color="red">  ✗ {error}</Text> : null}
      <Box marginTop={1}>
        <Text color="gray">  ↵ 확인  esc 취소</Text>
      </Box>
    </Box>
  );
}

interface ConfirmProps {
  title: string;
  body?: string;
  onYes: () => void;
  onNo: () => void;
  yesLabel?: string;
  noLabel?: string;
  dangerous?: boolean;
}

/** Y/N 확인 다이얼로그. Enter = Y, Esc = N. */
export function Confirm({
  title,
  body,
  onYes,
  onNo,
  yesLabel = '예',
  noLabel = '아니오',
  dangerous = false
}: ConfirmProps) {
  useInput((input, key) => {
    if (key.escape) {
      onNo();
      return;
    }
    if (input === 'y' || input === 'Y' || key.return) {
      onYes();
      return;
    }
    if (input === 'n' || input === 'N') {
      onNo();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color={dangerous ? 'red' : 'yellow'}>{title}</Text>
      {body ? (
        <Box marginTop={1} flexDirection="column">
          {body.split('\n').map((line, i) => (
            <Text key={i}>  {line}</Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">  </Text>
        <Text color={dangerous ? 'red' : 'green'}>[Y/↵] {yesLabel}</Text>
        <Text>   </Text>
        <Text color="gray">[N/esc] {noLabel}</Text>
      </Box>
    </Box>
  );
}

interface BusyProps {
  message: string;
}

/** 작업 중 표시 (스피너). */
export function Busy({ message }: BusyProps) {
  return (
    <Box>
      <Text color="cyan"><Spinner type="dots" /></Text>
      <Text> {message}</Text>
    </Box>
  );
}

interface MessageProps {
  tone: 'info' | 'success' | 'error' | 'warning';
  title: string;
  body?: string;
  onDismiss: () => void;
}

const TONE_COLOR: Record<MessageProps['tone'], string> = {
  info: 'cyan',
  success: 'green',
  error: 'red',
  warning: 'yellow'
};

const TONE_ICON: Record<MessageProps['tone'], string> = {
  info: 'ℹ',
  success: '✓',
  error: '✗',
  warning: '⚠'
};

/** 결과/에러 메시지 화면. Enter / Esc 로 해제. */
export function Message({ tone, title, body, onDismiss }: MessageProps) {
  useInput((_input, key) => {
    if (key.return || key.escape) onDismiss();
  });
  const color = TONE_COLOR[tone];
  const icon = TONE_ICON[tone];
  return (
    <Box flexDirection="column">
      <Text bold color={color}>{icon} {title}</Text>
      {body ? (
        <Box marginTop={1} flexDirection="column">
          {body.split('\n').map((line, i) => (
            <Text key={i}>  {line}</Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">  ↵/esc 확인</Text>
      </Box>
    </Box>
  );
}
