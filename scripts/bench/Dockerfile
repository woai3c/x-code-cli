# SWE-bench runner image: Node + git + a globally installed `xc`.
#
# Built once (`xc-bench:latest`) and reused by every benchmark instance so
# per-task containers start in seconds instead of reinstalling the CLI each
# time. The CLI is installed from npm — for local changes use:
#   docker build --build-arg XC_PACKAGE=file:///host/packages/cli
FROM node:22-slim

# git is required for clone + checkout; python3 for SWE-bench's Python-first
# repos. The venv sidesteps Debian's externally-managed pip so agents can
# install task dependencies without root tricks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip

ENV PATH="/opt/venv/bin:${PATH}"

ARG XC_PACKAGE=@x-code-cli/cli
RUN npm install -g "${XC_PACKAGE}" --no-audit --no-fund
