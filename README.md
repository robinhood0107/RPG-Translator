# RPG-Translator

Rust로 구현한 RPG Maker MV/MZ 텍스트 번역 도구다.

- 게임 파일 스캔, 로컬 모델 번역, 검수와 승인 캐시 내보내기
- 실행 중 나타난 미번역 문구의 파일 요청함과 Rust 작업자
- 메시지·창·비트맵·스프라이트·PIXI·Canvas 2D·HTML 텍스트 처리
- 오버레이 설치·복구와 데스크톱 라이트·다크 모드

이미지 안의 글자는 대상에서 제외한다. 실행·검증 범위와 아직 확인하지 않은 조건은 [실시간 번역 검증](docs/RUNTIME_TRANSLATION_VERIFICATION.ko.md), 코드 구조는 [유지보수 문서](docs/ARCHITECTURE.ko.md), 남은 작업은 [TODO](TODO.md)에 정리한다.

게임·모델·인증 정보와 로컬 검증 산출물은 저장소에 포함하지 않는다.
