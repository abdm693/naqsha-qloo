#!/bin/zsh
# Push main to github.com/abdm693/naqsha-qloo as abdm693 (a one-off auth header; no global git or gh config changes).
cd "$(dirname "$0")/.."
T=$(gh auth token -u abdm693)
git -c credential.helper= -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$T" | base64)" push origin main "$@"
