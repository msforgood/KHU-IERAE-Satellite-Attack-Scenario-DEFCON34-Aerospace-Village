#!/usr/bin/env bash
# save-image.sh — 인터넷 있는 환경에서 1회 실행.
#
# 빌드된 gpredict Docker 이미지를 tar 로 저장한다. 이 파일을 booth PC 의 같은 경로
# (common/attacker/gpredict-web/)로 USB/파일전송으로 복사해 두면, 부스 당일 install/up 은
# docker build(=레지스트리 접속·인터넷 필요, 익명 pull 한도로 로그인 요구 가능) 대신
# docker load 만으로 이미지를 준비한다 — ensure-image.sh 참고.
#
# 사용법:
#   ./save-image.sh          # demosat-gpredict.tar
#   GZIP=1 ./save-image.sh   # demosat-gpredict.tar.gz (전송 용량 절약, load 는 그대로 동작)
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
IMG="${IMG:-demosat-gpredict}"
OUT="${GP_IMG_TAR:-$HERE/demosat-gpredict.tar}"

# docker 는 네이티브 Win32 바이너리라 MSYS 경로(/c/...)를 못 읽는다 → 드라이브 문자 경로로.
to_host_path() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|*NT*) cygpath -m "$1" 2>/dev/null || printf '%s' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

docker image inspect "$IMG" >/dev/null 2>&1 \
  || { echo "✗ 이미지 '$IMG' 가 없습니다 — 먼저 './ensure-image.sh' 로 빌드하세요(인터넷 필요)" >&2; exit 1; }

echo "저장 중 → $OUT  (이미지 크기에 따라 다소 걸립니다)"
docker save -o "$(to_host_path "$OUT")" "$IMG"

if [ "${GZIP:-0}" = "1" ]; then
  echo "압축 중 → $OUT.gz"
  gzip -f "$OUT"
  OUT="$OUT.gz"
fi

echo "완료: $OUT ($(du -h "$OUT" | cut -f1))"
echo "이 파일을 booth PC 의 common/attacker/gpredict-web/ 로 복사하세요(git 에는 올라가지 않습니다)."
