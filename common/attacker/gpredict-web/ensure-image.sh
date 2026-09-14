#!/usr/bin/env bash
# ensure-image.sh — gpredict Docker 이미지를 최소 비용·오프라인 우선순위로 준비한다.
# run.sh(매 리셋)와 start-attacker.sh install(최초 설치)이 공용으로 부른다.
#
# ※ 이미지는 '반드시' 준비되어야 한다 — ③ 위성 조준(gpredict noVNC)이 있어야 참가자가
#   다음 단계로 넘어간다. 그래서 생략하지 않고, '어떻게 준비하느냐'만 상황에 맞게 고른다:
#
#   1) 이미 있으면 그대로 사용 — 오프라인·즉시(부스 리셋마다 여기 걸린다. 재빌드 안 함).
#   2) 없지만 사전 저장 tar(기본: 이 폴더의 demosat-gpredict.tar / .tar.gz, GP_IMG_TAR 로 재지정)
#      가 있으면 docker load — 오프라인, 레지스트리를 전혀 건드리지 않는다.
#      docker build 는 베이스 이미지를 받으러 레지스트리에 접속하는데, 부스처럼 인터넷이
#      없거나 공용 IP 뒤 익명 pull 한도에 걸리면 "로그인하라"며 실패한다. load 는 그 경로를
#      아예 타지 않는다.
#   3) 그것도 없으면 docker build — 최초 1회, 인터넷 필요.
# REBUILD=1 이면 1)을 건너뛰고 다시 준비한다(그래도 tar 가 있으면 build 보다 tar 를 우선).
#
# 부스 당일 인터넷이 없다고 가정하므로, 인터넷 있는 환경에서 미리 한 번 ./save-image.sh 를
# 돌려 tar 를 만들고 그 파일을 booth PC 의 이 폴더로 복사해 둔다(용량이 커서 git 에는 올리지
# 않는다 — .gitignore 처리됨. USB/파일전송으로 옮길 것).
#
# 사용: IMG=<이름> ./ensure-image.sh
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$HERE"
IMG="${IMG:-demosat-gpredict}"
TAR="${GP_IMG_TAR:-$HERE/demosat-gpredict.tar}"
[ -f "$TAR" ] || TAR="${TAR}.gz"   # .tar 가 없으면 .tar.gz 도 찾아본다(save-image.sh GZIP=1)

# docker 는 네이티브 Win32 바이너리라 MSYS 경로(/c/...)를 이해하지 못한다. 호스트 경로를
# 인자로 넘길 땐 run.sh 의 -v 마운트와 같은 방식으로 드라이브 문자 경로(C:/...)로 바꿔 준다.
to_host_path() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|*NT*) cygpath -m "$1" 2>/dev/null || printf '%s' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

if [ "${REBUILD:-0}" != "1" ] && docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "  ✓ gpredict 이미지 이미 준비됨($IMG, 재빌드 생략) — 새로 받으려면 REBUILD=1"
  exit 0
fi

if [ -f "$TAR" ]; then
  echo "  … gpredict 이미지 로드 중(사전 저장 tar, 인터넷 불필요) ← $TAR"
  # docker load 는 .tar 와 gzip 압축본을 모두 알아서 처리한다(별도 해제 불필요).
  LOADED="$(docker load -i "$(to_host_path "$TAR")" 2>&1 \
    | tee /tmp/demosat-docker-load.log | sed -n 's/^Loaded image: //p' | tail -1)"
  if [ -n "$LOADED" ]; then
    # tar 안의 태그가 우리가 쓸 이름과 다르면(GP_IMG 를 바꿔 쓴 경우) 이름을 맞춰 준다.
    [ "$LOADED" != "$IMG" ] && [ "$LOADED" != "$IMG:latest" ] && docker tag "$LOADED" "$IMG" >/dev/null 2>&1
    echo "  ✓ gpredict 이미지 로드됨($IMG ← $TAR)"
    exit 0
  fi
  echo "  ! tar 로드 실패($TAR) — /tmp/demosat-docker-load.log 확인, build 로 재시도" >&2
fi

# 빌드 컨텍스트는 '.'(위에서 cd 해 둠) — 호스트 경로를 인자로 넘기지 않아 Windows 에서도 안전.
echo "  … gpredict 이미지 빌드 중(최초, 인터넷 필요 — 베이스 이미지 다운로드) → $IMG"
docker build -t "$IMG" .
