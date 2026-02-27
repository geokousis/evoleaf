#!/usr/bin/env bash
set -euo pipefail

# Allow web workers (www-data) to install TeX Live packages via tlmgr.
for d in \
  /usr/local/texlive/2025/tlpkg \
  /usr/local/texlive/2025/texmf-var \
  /usr/local/texlive/2025/texmf-dist
 do
  if [[ -d "$d" ]]; then
    chgrp -R www-data "$d"
    chmod -R g+rwX "$d"
  fi
done
