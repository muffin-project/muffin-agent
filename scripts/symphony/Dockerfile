FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global opencode-ai@1.18.33 && npm cache clean --force
RUN useradd --uid 10001 --create-home worker
USER worker
ENTRYPOINT ["python3", "/adapter/bridge.py", "/adapter-config.json"]
