#!/usr/bin/env bash
set -euo pipefail

readonly JUST_VERSION="1.56.0"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    readonly JUST_ARCHIVE="just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz"
    readonly JUST_SHA256="fa2a8ec1015d9df5330941ade12437488fc40d33f9c9f8cd4eb70a26de11b639"
    ;;
  Linux-aarch64)
    readonly JUST_ARCHIVE="just-${JUST_VERSION}-aarch64-unknown-linux-musl.tar.gz"
    readonly JUST_SHA256="c8c1d656e9f47569ec1ae2bf8779af2621cdeea6bbbba3b0cacd64f951d25e2b"
    ;;
  Darwin-arm64)
    readonly JUST_ARCHIVE="just-${JUST_VERSION}-aarch64-apple-darwin.tar.gz"
    readonly JUST_SHA256="f35798d4bcdc4db020eef7d2853ad98bbfb97a4d29ee695ba042f18e7fedcc11"
    ;;
  Darwin-x86_64)
    readonly JUST_ARCHIVE="just-${JUST_VERSION}-x86_64-apple-darwin.tar.gz"
    readonly JUST_SHA256="09b35ff6d17023ffae37ce408d1a78a976d9e001cae54b88e238f7f40db9b783"
    ;;
  *)
    printf 'Unsupported just installer platform: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac
readonly JUST_URL="https://github.com/casey/just/releases/download/${JUST_VERSION}/${JUST_ARCHIVE}"
readonly DOWNLOAD_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pi-hive-just-${JUST_VERSION}"
readonly INSTALL_DIR="${HOME}/.local/bin"

rm -rf "${DOWNLOAD_DIR}"
mkdir -p "${DOWNLOAD_DIR}" "${INSTALL_DIR}"
curl --fail --location --proto '=https' --tlsv1.2 \
  --retry 3 --retry-all-errors \
  --output "${DOWNLOAD_DIR}/${JUST_ARCHIVE}" \
  "${JUST_URL}"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "${DOWNLOAD_DIR}/${JUST_ARCHIVE}" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "${DOWNLOAD_DIR}/${JUST_ARCHIVE}" | awk '{print $1}')"
fi
if [[ "${actual_sha256}" != "${JUST_SHA256}" ]]; then
  printf 'just archive checksum mismatch: expected %s, received %s\n' "${JUST_SHA256}" "${actual_sha256}" >&2
  exit 1
fi
tar --extract --gzip --file "${DOWNLOAD_DIR}/${JUST_ARCHIVE}" --directory "${DOWNLOAD_DIR}" just
install -m 0755 "${DOWNLOAD_DIR}/just" "${INSTALL_DIR}/just"
printf '%s\n' "${INSTALL_DIR}" >> "${GITHUB_PATH}"
"${INSTALL_DIR}/just" --version
