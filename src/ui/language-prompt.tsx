/**
 * 첫 실행 언어 선택 화면.
 *
 * 아직 언어가 정해지지 않은 상태라 문구는 카탈로그를 거치지 않고 영어·한국어를 함께 쓴다.
 * 시스템 locale 에 맞는 항목을 기본 선택으로 둔다.
 */

import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

import { LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type Locale } from '../i18n/index.js';

interface LanguagePromptProps {
  initial: Locale;
  onSelect: (locale: Locale) => void;
}

export function LanguagePrompt({ initial, onSelect }: LanguagePromptProps) {
  const items = SUPPORTED_LOCALES.map((locale) => ({
    label: LOCALE_NATIVE_NAMES[locale],
    value: locale,
    key: locale
  }));

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>  Choose your language / 사용할 언어를 선택하세요</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          initialIndex={Math.max(0, SUPPORTED_LOCALES.indexOf(initial))}
          onSelect={(item) => onSelect(item.value)}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">  ↑↓ move / 이동   ↵ select / 선택</Text>
        <Text color="gray">  Change it later / 나중에 변경: {'mat config language <en|ko>'}</Text>
      </Box>
    </Box>
  );
}
