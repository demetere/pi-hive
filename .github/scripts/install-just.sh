#!/usr/bin/env bash
set -euo pipefail

readonly JUST_VERSION="1.56.0"
readonly JUST_ARCHIVE="just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz"
readonly JUST_SHA256="fa2a8ec1015d9df5330941ade12437488fc40d33f9c9f8cd4eb70a26de11b639"
readonly JUST_URL="https://github.com/casey/just/releases/download/${JUST_VERSION}/${JUST_ARCHIVE}"
readonly DOWNLOAD_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pi-hive-just-${JUST_VERSION}"
readonly INSTALL_DIR="${HOME}/.local/bin"

rm -rf "${DOWNLOAD_DIR}"
mkdir -p "${DOWNLOAD_DIR}" "${INSTALL_DIR}"
curl --fail --location --proto '=https' --tlsv1.2 \
  --retry 3 --retry-all-errors \
  --output "${DOWNLOAD_DIR}/${JUST_ARCHIVE}" \
  "${JUST_URL}"
printf '%s  %s\n' "${JUST_SHA256}" "${DOWNLOAD_DIR}/${JUST_ARCHIVE}" | sha256sum --check --strict
tar --extract --gzip --file "${DOWNLOAD_DIR}/${JUST_ARCHIVE}" --directory "${DOWNLOAD_DIR}" just
install -m 0755 "${DOWNLOAD_DIR}/just" "${INSTALL_DIR}/just"
printf '%s\n' "${INSTALL_DIR}" >> "${GITHUB_PATH}"
"${INSTALL_DIR}/just" --version
