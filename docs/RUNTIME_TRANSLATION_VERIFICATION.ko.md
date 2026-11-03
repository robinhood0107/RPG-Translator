# 검증 수치

수치 기록은 [작업 일지](WORK_LOG.ko.md)와 [재수집 JSON](verification-metrics.json)에 모은다. 원문·번역문·등장인물·줄거리·게임 파일명·화면 내용은 기록하지 않는다.

```sh
python3 scripts/collect_verification_metrics.py \
  --db DATABASE --project-id 1 --inventory INVENTORY \
  --rust-log RUST_LOG --runtime-log RUNTIME_LOG --desktop-log DESKTOP_LOG \
  --output METRICS_JSON
python3 -m unittest discover -s scripts -p 'test_collect_verification_metrics.py'
```

| 분류 | 성공 | 실패 |
| --- | ---: | ---: |
| Rust | 204 | 0 |
| 런타임 | 192 | 0 |
| UI | 49 | 0 |
| 수치 기록 | 2 | 0 |
| 합계 | 447 | 0 |

검증된 경로 수치와 전수 검증 여부는 일지에서 별도 표시한다. DB의 검사 통과·수동 승인·원문 수를 번역 완료율 하나로 합치지 않는다.

검증 로그는 명령이 종료된 뒤 `VERIFICATION_EXIT_CODE` 숫자 마커를 남긴다. 마커가 없거나 종료 코드가 0이 아니면 수집기는 `verified_success=0`으로 기록한다.
