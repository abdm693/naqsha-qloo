#!/bin/zsh
# Asks for the Qloo API key without echoing it and stores it in the gitignored .env (replacing any earlier one).
set -e
cd "$(dirname "$0")/.."
read -rs "K?Qloo API key (input hidden): "
print
[[ -z $K ]] && { print "nothing entered"; exit 1; }
touch .env
grep -v '^QLOO_API_KEY=' .env > .env.tmp || true
print -r -- "QLOO_API_KEY=$K" >> .env.tmp
mv .env.tmp .env
unset K
print "saved to .env"
