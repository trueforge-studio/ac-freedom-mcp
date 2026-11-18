#!/bin/zsh
set -eu
cd "${0:A:h}/.."
typeset -a node_flags
action=--cloud-probe
if [[ "${1-}" == --list ]]; then
  action=--cloud-list
  shift
fi
if (( $# > 1 )); then
  print -u2 'Usage: npm run cloud-list or npm run cloud-probe -- [private environment file]'
  exit 2
fi
if (( $# == 1 )); then
  node_flags+=("--env-file=$1")
fi
if [[ ! -t 0 ]]; then
  print -u2 'Run this command in a terminal to enter your AC Freedom credentials.'
  exit 2
fi
read -r 'AC_CLOUD_EMAIL?AC Freedom email: '
read -rs 'AC_CLOUD_PASSWORD?AC Freedom password: '
print
export AC_CLOUD_EMAIL AC_CLOUD_PASSWORD
exec node "${node_flags[@]}" dist/index.js "$action"
