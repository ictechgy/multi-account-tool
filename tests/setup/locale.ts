// 기존 테스트는 한국어 메시지를 검증하므로 locale 을 ko 로 고정한다. 개발자 셸의
// LANG(예: en_US.UTF-8)에 따라 결과가 바뀌지 않도록, spawn 되는 `mat` 자식 프로세스도
// `{ ...process.env }` 로 이 값을 물려받는다. 영어 출력 검증은 테스트별로 MAT_LANG 을 덮어쓴다.
process.env.MAT_LANG = 'ko';
