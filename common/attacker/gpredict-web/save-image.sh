#!/usr/bin/env bash
# save-image.sh — 인터넷 있는 환경에서 1회 실행.
#
# 빌드된 gpredict Docker 이미지를 tar(선택: gzip 압축)로 저장한다. 이 파일을 booth PC 의
# 같은 경로(common/attacker/gpredict-web/)로 USB/파일전송 등으로 복사해 두면, 부스 당일
# install/up 은 docker build(=레지스트리 접속·인터넷 필요) 대신 docker load 만으로 이미지를
# 준비한다 — ensure-image.sh 참고.
#
# 사용법:
#   ./save-image.sh          # demosat-gpredict.tar 로 저장
#   GZIP=1 ./save-image.sh   # demosat-gpredict.tar.gz 로 압축 저장(파일 전송 시간 절약)
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
IMG="${IMG:-demosat-gpredict}"

docker image inspect "$IMG" >/dev/null 2>&1 \
  || { echo "✗ 이미지 '$IMG' 가 없습니다 — 먼저 './run.sh' 또는 './ensure-image.sh' 로 빌드하세요" >&2; exit 1; }

if [ "${GZIP:-0}" = "1" ]; then
  OUT="${GP_IMG_TAR:-$HERE/demosat-gpredict.tar.gz}"
  echo "저장 중(gzip 압축) → $OUT — 이미지 크기에 따라 다소 걸릴 수 있음"
  docker save "$IMG" | gzip > "$OUT"
else
  OUT="${GP_IMG_TAR:-$HERE/demosat-gpredict.tar}"
  echo "저장 중 → $OUT — 이미지 크기에 따라 다소 걸릴 수 있음"
  docker save -o "$OUT" "$IMG"
fi

echo "완료: $OUT ($(du -h "$OUT" | cut -f1))"
echo "이 파일을 booth PC 의 common/attacker/gpredict-web/ 로 복사하세요(git 에는 올라가지 않습니다)."
