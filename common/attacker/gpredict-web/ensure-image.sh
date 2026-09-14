#!/usr/bin/env bash
# ensure-image.sh — gpredict Docker 이미지를 최소 비용·오프라인 우선순위로 준비한다.
# run.sh(매 리셋)와 start-attacker.sh install(최초 설치) 이 공용으로 부른다.
#
# 우선순위:
#   1) 이미지가 이미 있으면 그대로 사용 — 오프라인, 즉시(리셋마다 이게 걸린다).
#   2) 없지만 사전에 저장해 둔 tar(기본: 이 폴더의 demosat-gpredict.tar, GP_IMG_TAR 로 재지정
#      가능)가 있으면 docker load — 오프라인, 레지스트리/인터넷을 전혀 건드리지 않는다(수 초).
#      docker build 가 베이스 이미지를 받으려고 레지스트리에 접속하다가 부스 현장처럼
#      공용 IP 뒤 익명 pull 한도에 걸리면 "로그인하라"는 에러를 내는데, load 는 그 경로 자체를
#      타지 않는다.
#   3) 그것도 없으면 docker build — 최초 1회, 베이스 이미지를 받기 위해 인터넷이 필요하다.
# REBUILD=1 이면 1)을 건너뛰고 다시 준비한다(그래도 tar 가 있으면 build 보다 tar 를 우선한다).
#
# 부스 당일 인터넷이 없다고 가정하므로, 반드시 인터넷 있는 환경에서 미리 한 번
#   ./save-image.sh
# 를 돌려 tar 를 만들고, 그 파일을 booth PC 의 같은 경로(gpredict-web/)로 복사해 둔다.
# (용량이 커서 git 에는 올리지 않는다 — .gitignore 처리됨. USB/파일전송으로 옮길 것.)
#
# 사용: IMG=<이름> ./ensure-image.sh   (독립 실행도, source 도 가능)
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
IMG="${IMG:-demosat-gpredict}"
TAR="${GP_IMG_TAR:-$HERE/demosat-gpredict.tar}"
[ -f "$TAR" ] || TAR="${TAR}.gz"   # .tar 가 없으면 .tar.gz 도 찾아본다

if [ "${REBUILD:-0}" != "1" ] && docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "  ✓ gpredict 이미지 이미 준비됨($IMG, 재빌드 생략) — 새로 받으려면 REBUILD=1"
  exit 0
fi

if [ -f "$TAR" ]; then
  echo "  … gpredict 이미지 로드 중(사전 저장 tar, 인터넷 불필요) ← $TAR"
  _cat_tar() { case "$1" in *.gz) gzip -dc "$1" ;; *) cat "$1" ;; esac; }
  LOADED="$(_cat_tar "$TAR" | docker load 2>&1 \
    | tee /tmp/demosat-docker-load.log | sed -n 's/^Loaded image: //p' | tail -1)"
  if [ -n "$LOADED" ]; then
    [ "$LOADED" != "$IMG" ] && [ "$LOADED" != "$IMG:latest" ] && docker tag "$LOADED" "$IMG" >/dev/null 2>&1
    echo "  ✓ gpredict 이미지 로드됨($IMG ← $TAR)"
    exit 0
  fi
  echo "  ! tar 로드 실패($TAR) — /tmp/demosat-docker-load.log 확인, build 로 재시도" >&2
fi

echo "  … gpredict 이미지 빌드 중(최초, 인터넷 필요 — 베이스 이미지 다운로드) → $IMG"
docker build -t "$IMG" "$HERE"
