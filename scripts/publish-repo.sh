#!/bin/zsh
# Creates the PUBLIC GitHub repo abdm693/naqsha-qloo (AGPL-3.0, detected from LICENSE) from this folder and pushes main.
set -e
cd "$(dirname "$0")/.."
export GH_TOKEN=$(gh auth token -u abdm693)
gh repo create abdm693/naqsha-qloo --public \
  --description "A home that follows the family's taste: Qloo's taste graph and Gemini agents design a bylaw-checked floor plan and a walkable 3D house styled for the people who will live in it." \
  --source . --remote origin --push
gh repo edit abdm693/naqsha-qloo --add-topic qloo --add-topic gemini --add-topic ai-agents --add-topic architecture --add-topic threejs --add-topic taste-graph
print "license: $(gh api repos/abdm693/naqsha-qloo --jq .license.spdx_id)"
